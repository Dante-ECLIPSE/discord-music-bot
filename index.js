const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

// ─── Client Setup ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Spotify Setup ──────────────────────────────────────────────────────────
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

async function refreshSpotifyToken() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    setTimeout(refreshSpotifyToken, (data.body['expires_in'] - 60) * 1000);
  } catch (err) {
    console.error('Spotify token error:', err.message);
    setTimeout(refreshSpotifyToken, 30000);
  }
}

// ─── Queue Manager ───────────────────────────────────────────────────────────
const queues = new Map(); // guildId -> GuildQueue

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      tracks: [],
      player: null,
      connection: null,
      current: null,
      loop: false,
      loopQueue: false,
      volume: 80,
      textChannel: null,
      nowPlayingMsg: null,
    });
  }
  return queues.get(guildId);
}

// ─── URL Detectors ───────────────────────────────────────────────────────────
function isYouTubeURL(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}
function isSpotifyURL(url) {
  return /open\.spotify\.com/i.test(url);
}
function isSoundCloudURL(url) {
  return /soundcloud\.com/i.test(url);
}

// ─── Track Resolvers ─────────────────────────────────────────────────────────

async function resolveYouTubeURL(url) {
  try {
    const info = await ytdl.getInfo(url);
    return [{
      title: info.videoDetails.title,
      url: url,
      duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
      thumbnail: info.videoDetails.thumbnails[0]?.url,
      source: 'youtube',
    }];
  } catch {
    return null;
  }
}

async function resolveYouTubePlaylist(url) {
  try {
    const playlistId = url.match(/[?&]list=([^&]+)/)?.[1];
    if (!playlistId) return null;
    const r = await ytSearch({ listId: playlistId });
    return r.videos.map(v => ({
      title: v.title,
      url: v.url,
      duration: v.duration.timestamp,
      thumbnail: v.thumbnail,
      source: 'youtube',
    }));
  } catch {
    return null;
  }
}

async function resolveSpotifyTrack(url) {
  const trackId = url.match(/track\/([A-Za-z0-9]+)/)?.[1];
  if (!trackId) return null;
  try {
    const data = await spotifyApi.getTrack(trackId);
    const t = data.body;
    const query = `${t.name} ${t.artists.map(a => a.name).join(' ')}`;
    return [await searchYouTube(query, 'spotify', t.album?.images[0]?.url)];
  } catch {
    return null;
  }
}

async function resolveSpotifyPlaylist(url) {
  const playlistId = url.match(/playlist\/([A-Za-z0-9]+)/)?.[1];
  if (!playlistId) return null;
  try {
    const data = await spotifyApi.getPlaylistTracks(playlistId, { limit: 50 });
    const tracks = [];
    for (const item of data.body.items) {
      const t = item.track;
      if (!t) continue;
      const query = `${t.name} ${t.artists.map(a => a.name).join(' ')}`;
      const track = await searchYouTube(query, 'spotify', t.album?.images[0]?.url);
      if (track) tracks.push(track);
    }
    return tracks;
  } catch {
    return null;
  }
}

async function resolveSpotifyAlbum(url) {
  const albumId = url.match(/album\/([A-Za-z0-9]+)/)?.[1];
  if (!albumId) return null;
  try {
    const data = await spotifyApi.getAlbumTracks(albumId, { limit: 50 });
    const albumInfo = await spotifyApi.getAlbum(albumId);
    const thumb = albumInfo.body.images[0]?.url;
    const tracks = [];
    for (const t of data.body.items) {
      const query = `${t.name} ${t.artists.map(a => a.name).join(' ')}`;
      const track = await searchYouTube(query, 'spotify', thumb);
      if (track) tracks.push(track);
    }
    return tracks;
  } catch {
    return null;
  }
}

async function resolveSoundCloudURL(url) {
  // yt-dlp handles SoundCloud
  return new Promise((resolve) => {
    exec(`yt-dlp --print title --print duration --no-playlist "${url}"`, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.trim().split('\n');
      const title = lines[0] || 'Unknown Title';
      const duration = lines[1] ? formatDuration(parseInt(lines[1])) : '?:??';
      resolve([{ title, url, duration, thumbnail: null, source: 'soundcloud' }]);
    });
  });
}

async function searchYouTube(query, source = 'youtube', thumb = null) {
  try {
    const r = await ytSearch(query);
    const v = r.videos[0];
    if (!v) return null;
    return {
      title: v.title,
      url: v.url,
      duration: v.duration.timestamp,
      thumbnail: thumb || v.thumbnail,
      source,
    };
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  if (isNaN(seconds)) return '?:??';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Resolve any input ────────────────────────────────────────────────────────
async function resolveTracks(input) {
  if (isYouTubeURL(input)) {
    if (input.includes('list=')) return await resolveYouTubePlaylist(input);
    return await resolveYouTubeURL(input);
  }
  if (isSpotifyURL(input)) {
    if (input.includes('/track/')) return await resolveSpotifyTrack(input);
    if (input.includes('/playlist/')) return await resolveSpotifyPlaylist(input);
    if (input.includes('/album/')) return await resolveSpotifyAlbum(input);
  }
  if (isSoundCloudURL(input)) return await resolveSoundCloudURL(input);
  // plain search
  const track = await searchYouTube(input);
  return track ? [track] : null;
}

// ─── Audio Playback ──────────────────────────────────────────────────────────
async function createStream(url, source) {
  // For SoundCloud and other sites, use yt-dlp piped audio
  if (source === 'soundcloud') {
    const { spawn } = require('child_process');
    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '-o', '-',
      '--no-playlist',
      url,
    ]);
    return createAudioResource(proc.stdout, { inlineVolume: true });
  }
  // YouTube
  const stream = ytdl(url, {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25,
  });
  return createAudioResource(stream, { inlineVolume: true });
}

async function playNext(guildId) {
  const q = getQueue(guildId);
  if (!q.tracks.length && !q.loopQueue) {
    q.current = null;
    sendEmbed(q.textChannel, '⏹️ Queue finished', 'No more tracks. Use `/play` to add more!', 0x5865f2);
    return;
  }

  if (q.loopQueue && q.current && !q.loop) {
    q.tracks.push(q.current); // rotate
  }

  const track = q.loop && q.current ? q.current : q.tracks.shift();
  q.current = track;

  try {
    const resource = await createStream(track.url, track.source);
    resource.volume?.setVolume(q.volume / 100);
    q.player.play(resource);
    sendNowPlaying(q, track);
  } catch (err) {
    console.error('Playback error:', err);
    sendEmbed(q.textChannel, '❌ Playback Error', `Could not play **${track.title}**. Skipping...`, 0xe74c3c);
    playNext(guildId);
  }
}

async function sendNowPlaying(q, track) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 Now Playing')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: '⏱️ Duration', value: track.duration || '?:??', inline: true },
      { name: '🔊 Volume', value: `${q.volume}%`, inline: true },
      { name: '🔁 Loop', value: q.loop ? 'Track' : q.loopQueue ? 'Queue' : 'Off', inline: true },
    )
    .setFooter({ text: `Source: ${track.source.toUpperCase()} • ${q.tracks.length} track(s) in queue` });

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('queue').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('loop').setEmoji('🔁').setStyle(ButtonStyle.Primary),
  );

  try {
    if (q.nowPlayingMsg) await q.nowPlayingMsg.delete().catch(() => {});
    q.nowPlayingMsg = await q.textChannel.send({ embeds: [embed], components: [row] });
  } catch {}
}

function sendEmbed(channel, title, desc, color = 0x5865f2) {
  if (!channel) return;
  channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)] }).catch(() => {});
}

// ─── Join + Setup Player ─────────────────────────────────────────────────────
function setupPlayer(guildId) {
  const q = getQueue(guildId);
  if (q.player) return q.player;

  const player = createAudioPlayer();
  q.player = player;

  player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
  player.on('error', (err) => {
    console.error('Player error:', err);
    playNext(guildId);
  });

  return player;
}

async function joinChannel(voiceChannel, guildId) {
  const q = getQueue(guildId);

  // If already connected, reuse
  if (q.connection) {
    const status = q.connection.state.status;
    if (status !== VoiceConnectionStatus.Destroyed) {
      const player = setupPlayer(guildId);
      q.connection.subscribe(player);
      return q.connection;
    }
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000); // increased to 30s
  } catch (err) {
    connection.destroy();
    queues.delete(guildId);
    throw new Error('Could not connect to voice channel');
  }

  q.connection = connection;
  const player = setupPlayer(guildId);
  connection.subscribe(player);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      queues.delete(guildId);
    }
  });

  return connection;
}
// ─── Slash Commands ──────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play music from YouTube, Spotify, SoundCloud, or search query')
    .addStringOption(o => o.setName('query').setDescription('Song name, URL (YouTube/Spotify/SoundCloud)').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear the queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (1–100)')
    .addIntegerOption(o => o.setName('level').setDescription('Volume level').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle loop mode')
    .addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a track from the queue')
    .addIntegerOption(o => o.setName('position').setDescription('Track position (1-based)').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('seek').setDescription('Seek to a position in the current track')
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds to seek to').setMinValue(0).setRequired(true)),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect the bot from voice'),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
].map(c => c.toJSON());

// ─── Register Commands ────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('Command registration error:', err);
  }
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  const guildId = interaction.guildId;

  // ── Button Handler ──
  if (interaction.isButton()) {
    const q = getQueue(guildId);
    await interaction.deferUpdate().catch(() => {});

    if (interaction.customId === 'pause') {
      if (q.player?.state.status === AudioPlayerStatus.Playing) q.player.pause();
      else q.player?.unpause();
    } else if (interaction.customId === 'skip') {
      q.player?.stop();
    } else if (interaction.customId === 'stop') {
      q.tracks = [];
      q.loop = false;
      q.loopQueue = false;
      q.player?.stop();
      q.connection?.destroy();
      queues.delete(guildId);
    } else if (interaction.customId === 'queue') {
      await showQueue(interaction, q, true);
    } else if (interaction.customId === 'loop') {
      if (!q.loop && !q.loopQueue) q.loop = true;
      else if (q.loop) { q.loop = false; q.loopQueue = true; }
      else { q.loopQueue = false; }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const q = getQueue(guildId);
  const { commandName, options, member, channel } = interaction;

  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎵 Music Bot Commands')
      .setDescription([
        '`/play <query or URL>` — Play from YouTube, Spotify, SoundCloud, or search',
        '`/skip` — Skip current track',
        '`/stop` — Stop and clear queue',
        '`/pause` / `/resume` — Pause or resume',
        '`/queue` — Show queue',
        '`/nowplaying` — Show current track',
        '`/volume <1-100>` — Set volume',
        '`/loop <off|track|queue>` — Set loop mode',
        '`/shuffle` — Shuffle queue',
        '`/remove <pos>` — Remove track from queue',
        '`/seek <seconds>` — Seek in track',
        '`/leave` — Disconnect bot',
      ].join('\n'))
      .setFooter({ text: 'Supports: YouTube • YouTube Music • Spotify • SoundCloud • Search' });
    return interaction.reply({ embeds: [embed] });
  }

 if (commandName === 'play') {
    const query = options.getString('query');
    const voiceChannel = member.voice?.channel;
    if (!voiceChannel) return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });

    // Defer IMMEDIATELY before anything else
    try { await interaction.deferReply(); } catch { return; }
    q.textChannel = channel;

    try {
      if (!q.connection) await joinChannel(voiceChannel, guildId);
    } catch (err) {
      console.error('Join error:', err);
      return interaction.editReply('❌ Could not join your voice channel. Try again!');
    }
    const tracks = await resolveTracks(query);
    if (!tracks || !tracks.length) return interaction.editReply('❌ No results found.');

    q.tracks.push(...tracks);

    const isPlaylist = tracks.length > 1;
    const embed = new EmbedBuilder().setColor(0x5865f2);

    if (isPlaylist) {
      embed.setTitle('📋 Playlist Added').setDescription(`Added **${tracks.length} tracks** to the queue`);
    } else {
      embed.setTitle('✅ Added to Queue').setDescription(`**[${tracks[0].title}](${tracks[0].url})**`)
        .addFields({ name: '⏱️ Duration', value: tracks[0].duration || '?:??', inline: true });
      if (tracks[0].thumbnail) embed.setThumbnail(tracks[0].thumbnail);
    }

    await interaction.editReply({ embeds: [embed] });

    if (q.player?.state.status !== AudioPlayerStatus.Playing) playNext(guildId);
    return;
  }

  if (commandName === 'skip') {
    if (!q.player) return interaction.reply({ content: '❌ Nothing playing.', ephemeral: true });
    q.player.stop();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('⏭️ Skipped!')] });
  }

  if (commandName === 'stop') {
    q.tracks = [];
    q.loop = false;
    q.loopQueue = false;
    q.player?.stop();
    q.connection?.destroy();
    queues.delete(guildId);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('⏹️ Stopped and disconnected.')] });
  }

  if (commandName === 'pause') {
    q.player?.pause();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setDescription('⏸️ Paused.')] });
  }

  if (commandName === 'resume') {
    q.player?.unpause();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('▶️ Resumed.')] });
  }

  if (commandName === 'queue') {
    return showQueue(interaction, q);
  }

  if (commandName === 'nowplaying') {
    if (!q.current) return interaction.reply({ content: '❌ Nothing playing.', ephemeral: true });
    const t = q.current;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎵 Now Playing')
      .setDescription(`**[${t.title}](${t.url})**`)
      .addFields(
        { name: '⏱️ Duration', value: t.duration || '?:??', inline: true },
        { name: '🔊 Volume', value: `${q.volume}%`, inline: true },
        { name: '🔁 Loop', value: q.loop ? 'Track' : q.loopQueue ? 'Queue' : 'Off', inline: true },
      );
    if (t.thumbnail) embed.setThumbnail(t.thumbnail);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'volume') {
    const level = options.getInteger('level');
    q.volume = level;
    if (q.player?.state?.resource?.volume) {
      q.player.state.resource.volume.setVolume(level / 100);
    }
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`🔊 Volume set to **${level}%**`)] });
  }

  if (commandName === 'loop') {
    const mode = options.getString('mode');
    q.loop = mode === 'track';
    q.loopQueue = mode === 'queue';
    const labels = { off: '🔁 Loop **disabled**', track: '🔂 Looping **current track**', queue: '🔁 Looping **queue**' };
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(labels[mode])] });
  }

  if (commandName === 'shuffle') {
    for (let i = q.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
    }
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('🔀 Queue shuffled!')] });
  }

  if (commandName === 'remove') {
    const pos = options.getInteger('position') - 1;
    if (pos < 0 || pos >= q.tracks.length) return interaction.reply({ content: '❌ Invalid position.', ephemeral: true });
    const [removed] = q.tracks.splice(pos, 1);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(`🗑️ Removed **${removed.title}**`)] });
  }

  if (commandName === 'leave') {
    q.connection?.destroy();
    queues.delete(guildId);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('👋 Disconnected!')] });
  }
});

async function showQueue(interaction, q, isButton = false) {
  if (!q.current && !q.tracks.length) {
    const reply = { content: '❌ The queue is empty!', ephemeral: true };
    return isButton ? interaction.followUp(reply) : interaction.reply(reply);
  }

  const lines = [];
  if (q.current) lines.push(`**▶️ Now:** [${q.current.title}](${q.current.url}) \`${q.current.duration || '?:??'}\``);
  q.tracks.slice(0, 15).forEach((t, i) => {
    lines.push(`**${i + 1}.** [${t.title}](${t.url}) \`${t.duration || '?:??'}\``);
  });
  if (q.tracks.length > 15) lines.push(`...and **${q.tracks.length - 15}** more tracks`);

  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle('📋 Queue')
    .setDescription(lines.join('\n') || 'Empty')
    .setFooter({ text: `${q.tracks.length} track(s) • Loop: ${q.loop ? 'Track' : q.loopQueue ? 'Queue' : 'Off'}` });

  const reply = { embeds: [embed], ephemeral: isButton };
  return isButton ? interaction.followUp(reply) : interaction.reply(reply);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('🎵 /play to start', { type: 2 });
  await registerCommands();
  if (process.env.SPOTIFY_CLIENT_ID) await refreshSpotifyToken();
});

client.login(process.env.DISCORD_TOKEN);
