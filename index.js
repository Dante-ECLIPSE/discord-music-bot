const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
const { exec, spawn } = require('child_process');
require('dotenv').config();

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Spotify ──────────────────────────────────────────────────────────────────
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
});
async function refreshSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID) return;
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    setTimeout(refreshSpotifyToken, (data.body['expires_in'] - 60) * 1000);
  } catch (e) {
    setTimeout(refreshSpotifyToken, 60000);
  }
}

// ─── Queue ────────────────────────────────────────────────────────────────────
const queues = new Map();
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      tracks: [], player: null, connection: null,
      current: null, loop: false, loopQueue: false,
      volume: 80, textChannel: null, nowPlayingMsg: null,
      retries: 0,
    });
  }
  return queues.get(guildId);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function fmt(sec) {
  if (!sec || isNaN(sec)) return '?:??';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
const isYT = u => /(?:youtube\.com|youtu\.be)/i.test(u);
const isSP = u => /open\.spotify\.com/i.test(u);
const isSC = u => /soundcloud\.com/i.test(u);

// ─── Resolvers ────────────────────────────────────────────────────────────────
async function searchYT(query, source = 'youtube', thumb = null) {
  try {
    const r = await ytSearch(query);
    const v = r.videos[0];
    if (!v) return null;
    return { title: v.title, url: v.url, duration: v.duration.timestamp, thumbnail: thumb || v.thumbnail, source };
  } catch { return null; }
}

async function resolveTracks(input) {
  if (isYT(input)) {
    if (input.includes('list=')) {
      try {
        const id = input.match(/[?&]list=([^&]+)/)?.[1];
        const r = await ytSearch({ listId: id });
        return r.videos.map(v => ({ title: v.title, url: v.url, duration: v.duration.timestamp, thumbnail: v.thumbnail, source: 'youtube' }));
      } catch { return null; }
    }
    try {
      const info = await ytdl.getInfo(input);
      return [{ title: info.videoDetails.title, url: input, duration: fmt(parseInt(info.videoDetails.lengthSeconds)), thumbnail: info.videoDetails.thumbnails[0]?.url, source: 'youtube' }];
    } catch { return null; }
  }
  if (isSP(input) && process.env.SPOTIFY_CLIENT_ID) {
    if (input.includes('/track/')) {
      try {
        const id = input.match(/track\/([A-Za-z0-9]+)/)?.[1];
        const d = await spotifyApi.getTrack(id);
        const t = d.body;
        return [await searchYT(`${t.name} ${t.artists.map(a=>a.name).join(' ')}`, 'spotify', t.album?.images[0]?.url)];
      } catch { return null; }
    }
    if (input.includes('/playlist/')) {
      try {
        const id = input.match(/playlist\/([A-Za-z0-9]+)/)?.[1];
        const d = await spotifyApi.getPlaylistTracks(id, { limit: 50 });
        const tracks = [];
        for (const item of d.body.items) {
          if (!item.track) continue;
          const t = item.track;
          const track = await searchYT(`${t.name} ${t.artists.map(a=>a.name).join(' ')}`, 'spotify', t.album?.images[0]?.url);
          if (track) tracks.push(track);
        }
        return tracks;
      } catch { return null; }
    }
  }
  if (isSC(input)) {
    return new Promise(resolve => {
      exec(`yt-dlp --print title --print duration --no-playlist "${input}"`, (err, out) => {
        if (err) return resolve(null);
        const [title, dur] = out.trim().split('\n');
        resolve([{ title: title || 'Unknown', url: input, duration: fmt(parseInt(dur)), thumbnail: null, source: 'soundcloud' }]);
      });
    });
  }
  const t = await searchYT(input);
  return t ? [t] : null;
}

// ─── Stream ───────────────────────────────────────────────────────────────────
async function createStream(track) {
  if (track.source === 'soundcloud') {
    const proc = spawn('yt-dlp', ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', track.url]);
    proc.stderr.on('data', d => console.error('yt-dlp:', d.toString()));
    return createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
  }

  // Use yt-dlp for YouTube too — much more stable than ytdl on hosted servers
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=webm]/bestaudio/best',
      '--no-playlist',
      '-o', '-',
      track.url,
    ]);
    proc.stderr.on('data', d => console.error('yt-dlp:', d.toString().trim()));
    proc.on('error', reject);
    // Give the stream a moment to start
    setTimeout(() => {
      resolve(createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true }));
    }, 200);
  });
}

// ─── Playback ─────────────────────────────────────────────────────────────────
async function playNext(guildId) {
  const q = getQueue(guildId);

  if (!q.tracks.length && !q.loopQueue) {
    q.current = null;
    sendEmbed(q.textChannel, '⏹️ Queue finished', 'No more tracks! Use `/play` to add more.');
    return;
  }

  if (q.loopQueue && q.current && !q.loop) q.tracks.push(q.current);
  const track = (q.loop && q.current) ? q.current : q.tracks.shift();
  q.current = track;
  q.retries = 0;

  await attemptPlay(guildId, track);
}

async function attemptPlay(guildId, track) {
  const q = getQueue(guildId);
  try {
    const resource = await createStream(track);
    resource.volume?.setVolume(q.volume / 100);
    q.player.play(resource);
    await sendNowPlaying(q, track);
  } catch (err) {
    console.error('Play error:', err.message);
    q.retries = (q.retries || 0) + 1;
    if (q.retries < 3) {
      console.log(`Retrying (${q.retries}/3)...`);
      setTimeout(() => attemptPlay(guildId, track), 2000);
    } else {
      sendEmbed(q.textChannel, '❌ Skipped', `Could not play **${track.title}**`, 0xe74c3c);
      setTimeout(() => playNext(guildId), 1000);
    }
  }
}

function setupPlayer(guildId) {
  const q = getQueue(guildId);
  if (q.player) return q.player;

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  q.player = player;

  player.on(AudioPlayerStatus.Idle, () => setTimeout(() => playNext(guildId), 500));
  player.on('error', err => {
    console.error('Player error:', err.message);
    setTimeout(() => playNext(guildId), 1000);
  });

  return player;
}

// ─── Voice Connection ─────────────────────────────────────────────────────────
async function connectToChannel(voiceChannel, guildId) {
  const q = getQueue(guildId);

  // Destroy stale connection
  if (q.connection) {
    const s = q.connection.state.status;
    if (s !== VoiceConnectionStatus.Destroyed) {
      if (s === VoiceConnectionStatus.Ready || s === VoiceConnectionStatus.Signalling || s === VoiceConnectionStatus.Connecting) {
        // Already connected or connecting — reuse
        const player = setupPlayer(guildId);
        q.connection.subscribe(player);
        return q.connection;
      }
      q.connection.destroy();
    }
    q.connection = null;
  }

  console.log(`Joining voice channel ${voiceChannel.id} in guild ${guildId}`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  // Wait up to 30s for Ready
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log('Voice connection ready!');
  } catch (err) {
    console.error('Voice connection failed:', err.message);
    connection.destroy();
    throw new Error('Failed to connect to voice channel');
  }

  q.connection = connection;
  const player = setupPlayer(guildId);
  connection.subscribe(player);

  // Reconnect on disconnect
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('Disconnected — attempting reconnect...');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 10_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 10_000),
      ]);
      console.log('Reconnected!');
    } catch {
      console.log('Could not reconnect, destroying connection');
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      const existingQ = queues.get(guildId);
      if (existingQ) { existingQ.connection = null; existingQ.player = null; }
      sendEmbed(q.textChannel, '🔌 Disconnected', 'Lost connection! Use `/play` to reconnect.', 0xe74c3c);
    }
  });

  return connection;
}

// ─── Embeds ───────────────────────────────────────────────────────────────────
async function sendNowPlaying(q, track) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2).setTitle('🎵 Now Playing')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: '⏱️ Duration', value: track.duration || '?:??', inline: true },
      { name: '🔊 Volume', value: `${q.volume}%`, inline: true },
      { name: '🔁 Loop', value: q.loop ? 'Track' : q.loopQueue ? 'Queue' : 'Off', inline: true },
    )
    .setFooter({ text: `${track.source.toUpperCase()} • ${q.tracks.length} in queue` });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_queue').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_loop').setEmoji('🔁').setStyle(ButtonStyle.Primary),
  );

  try {
    if (q.nowPlayingMsg) await q.nowPlayingMsg.delete().catch(() => {});
    q.nowPlayingMsg = await q.textChannel.send({ embeds: [embed], components: [row] });
  } catch (e) { console.error('sendNowPlaying error:', e.message); }
}

function sendEmbed(ch, title, desc, color = 0x5865f2) {
  if (!ch) return;
  ch.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)] }).catch(() => {});
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play music from YouTube, Spotify, SoundCloud or search')
    .addStringOption(o => o.setName('query').setDescription('Song name or URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current track'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and clear queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume'),
  new SlashCommandBuilder().setName('queue').setDescription('Show queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Current track'),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (1-100)')
    .addIntegerOption(o => o.setName('level').setDescription('Volume').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('loop').setDescription('Loop mode')
    .addStringOption(o => o.setName('mode').setDescription('Mode').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle queue'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove track')
    .addIntegerOption(o => o.setName('position').setDescription('Position').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect'),
  new SlashCommandBuilder().setName('help').setDescription('All commands'),
].map(c => c.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commands registered!');
  } catch (e) { console.error('Register error:', e.message); }
}

// ─── Event Handler ────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  const guildId = interaction.guildId;

  if (interaction.isButton()) {
    const q = getQueue(guildId);
    await interaction.deferUpdate().catch(() => {});
    if (interaction.customId === 'btn_pause') {
      q.player?.state.status === AudioPlayerStatus.Playing ? q.player.pause() : q.player?.unpause();
    } else if (interaction.customId === 'btn_skip') {
      q.player?.stop();
    } else if (interaction.customId === 'btn_stop') {
      q.tracks = []; q.loop = false; q.loopQueue = false;
      q.player?.stop(); q.connection?.destroy(); queues.delete(guildId);
    } else if (interaction.customId === 'btn_queue') {
      await showQueue(interaction, q, true);
    } else if (interaction.customId === 'btn_loop') {
      if (!q.loop && !q.loopQueue) q.loop = true;
      else if (q.loop) { q.loop = false; q.loopQueue = true; }
      else q.loopQueue = false;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const q = getQueue(guildId);
  const { commandName, options, member, channel } = interaction;

  if (commandName === 'help') {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎵 Commands')
      .setDescription('`/play` • `/skip` • `/stop` • `/pause` • `/resume`\n`/queue` • `/nowplaying` • `/volume` • `/loop`\n`/shuffle` • `/remove` • `/leave`')
      .setFooter({ text: 'Supports: YouTube • Spotify • SoundCloud • Search' })] });
  }

  if (commandName === 'play') {
    const query = options.getString('query');
    const vc = member.voice?.channel;
    if (!vc) return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });

    try { await interaction.deferReply(); } catch { return; }
    q.textChannel = channel;

    try {
      await connectToChannel(vc, guildId);
    } catch (err) {
      console.error('Connect error:', err.message);
      return interaction.editReply('❌ Could not join voice channel. Make sure I have permission and try again!');
    }

    const tracks = await resolveTracks(query).catch(e => { console.error(e); return null; });
    if (!tracks?.length) return interaction.editReply('❌ No results found. Try a different search!');

    q.tracks.push(...tracks);

    const embed = new EmbedBuilder().setColor(0x5865f2);
    if (tracks.length > 1) {
      embed.setTitle('📋 Playlist Added').setDescription(`Added **${tracks.length} tracks** to the queue`);
    } else {
      embed.setTitle('✅ Added to Queue').setDescription(`**[${tracks[0].title}](${tracks[0].url})**`)
        .addFields({ name: '⏱️ Duration', value: tracks[0].duration || '?:??', inline: true });
      if (tracks[0].thumbnail) embed.setThumbnail(tracks[0].thumbnail);
    }
    await interaction.editReply({ embeds: [embed] });

    if (!q.player || q.player.state.status === AudioPlayerStatus.Idle) playNext(guildId);
    return;
  }

  if (commandName === 'skip') {
    if (!q.current) return interaction.reply({ content: '❌ Nothing playing.', ephemeral: true });
    q.player?.stop();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('⏭️ Skipped!')] });
  }
  if (commandName === 'stop') {
    q.tracks = []; q.loop = false; q.loopQueue = false;
    q.player?.stop(); q.connection?.destroy(); queues.delete(guildId);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('⏹️ Stopped.')] });
  }
  if (commandName === 'pause') {
    q.player?.pause();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setDescription('⏸️ Paused.')] });
  }
  if (commandName === 'resume') {
    q.player?.unpause();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('▶️ Resumed.')] });
  }
  if (commandName === 'queue') return showQueue(interaction, q);
  if (commandName === 'nowplaying') {
    if (!q.current) return interaction.reply({ content: '❌ Nothing playing.', ephemeral: true });
    const t = q.current;
    const e = new EmbedBuilder().setColor(0x5865f2).setTitle('🎵 Now Playing')
      .setDescription(`**[${t.title}](${t.url})**`)
      .addFields({ name: '⏱️', value: t.duration||'?:??', inline:true }, { name: '🔊', value: `${q.volume}%`, inline:true }, { name: '🔁', value: q.loop?'Track':q.loopQueue?'Queue':'Off', inline:true });
    if (t.thumbnail) e.setThumbnail(t.thumbnail);
    return interaction.reply({ embeds: [e] });
  }
  if (commandName === 'volume') {
    const level = options.getInteger('level');
    q.volume = level;
    if (q.player?.state?.resource?.volume) q.player.state.resource.volume.setVolume(level / 100);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`🔊 Volume: **${level}%**`)] });
  }
  if (commandName === 'loop') {
    const mode = options.getString('mode');
    q.loop = mode === 'track'; q.loopQueue = mode === 'queue';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(
      mode==='off'?'🔁 Loop off':mode==='track'?'🔂 Looping track':'🔁 Looping queue'
    )] });
  }
  if (commandName === 'shuffle') {
    for (let i=q.tracks.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[q.tracks[i],q.tracks[j]]=[q.tracks[j],q.tracks[i]];}
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('🔀 Shuffled!')] });
  }
  if (commandName === 'remove') {
    const pos = options.getInteger('position') - 1;
    if (pos < 0 || pos >= q.tracks.length) return interaction.reply({ content: '❌ Invalid position.', ephemeral: true });
    const [r] = q.tracks.splice(pos, 1);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(`🗑️ Removed **${r.title}**`)] });
  }
  if (commandName === 'leave') {
    q.connection?.destroy(); queues.delete(guildId);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('👋 Bye!')] });
  }
});

async function showQueue(interaction, q, isButton = false) {
  if (!q.current && !q.tracks.length) {
    const r = { content: '❌ Queue is empty!', ephemeral: true };
    return isButton ? interaction.followUp(r) : interaction.reply(r);
  }
  const lines = [];
  if (q.current) lines.push(`**▶️ Now:** [${q.current.title}](${q.current.url}) \`${q.current.duration||'?:??'}\``);
  q.tracks.slice(0,15).forEach((t,i) => lines.push(`**${i+1}.** [${t.title}](${t.url}) \`${t.duration||'?:??'}\``));
  if (q.tracks.length > 15) lines.push(`...and **${q.tracks.length-15}** more`);
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Queue').setDescription(lines.join('\n')||'Empty')
    .setFooter({ text: `${q.tracks.length} track(s) • Loop: ${q.loop?'Track':q.loopQueue?'Queue':'Off'}` });
  const r = { embeds: [e], ephemeral: isButton };
  return isButton ? interaction.followUp(r) : interaction.reply(r);
}

// ─── Start ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('🎵 /play to start', { type: 2 });
  await registerCommands();
  if (process.env.SPOTIFY_CLIENT_ID) await refreshSpotifyToken();
});

client.login(process.env.DISCORD_TOKEN);
