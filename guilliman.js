import dotenv from 'dotenv';
dotenv.config();
import { ChannelType } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { parse as csvParse } from 'csv-parse/sync';
import { create, all } from 'mathjs';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';  // <-- only here, once

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const Jimp = require('jimp');

import Tesseract from 'tesseract.js';
import express from 'express';
import sharp from 'sharp';
import fetch from 'node-fetch';

const math = create(all);
math.config({ number:'number', precision:64 });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});


/* ---------- CONFIG ---------- */

const COUNTING_CHANNEL_ID   = '1348370380657524896';
const COUNTING_BOT_ID       = '510016054391734273';
const MONTHLY_CHANNEL_ID    = '1252204884426756193';
const NEW_GEN_ROLE_ID       = '1354540452283682967';
const TATSUMAKI_BOT_ID      = '172002275412279296';
const BINGO_STRIKER_ROLE    = '1374818698334048448';   
const BENCHWARMER_ROLE      = '1374818741216608469';   
const CLOWN_ROLE            = '1374818786502246400';   
const TATSU_CHANNEL_ID      = '1252204884426756193';
const EVOLUTION_CHANNEL_ID = '1388984587237195906';

const STAFF_ROLE_IDS = [
  '1364897584031993973','1252204883667320885','1351661038902181969',
  '1252204883667320886','1351850232337530901','1364944237069598792',
  '1351853373007335444','1356635617437548607','1364957729675804774',
  '1364930057683992637','1252204883667320889','1252204883667320890',
  '1358801211901345916',
];

const delay  = ms=>new Promise(r=>setTimeout(r,ms));


const RIN_APP_ID = '429656936435286016';   // always string!
const GUILD_ID = '1252204883533103145';    // always string!

let sessionId

client.once('ready', () => {
  const channel = client.channels.fetch('1356006813815935096');
  console.log('Channel:', channel);
  console.log('Channel type:', channel.type);
  console.log('Channel type enum GuildForum:', ChannelType.GuildForum);
});



const xpClaimQueue = [];
let processingXP = false;


async function processXPQueue(client) {
  processingXP = true;

  while (xpClaimQueue.length > 0) {
    const { userId, xpAmount } = xpClaimQueue.shift();

    const xpChannel = await client.channels.fetch(TATSU_CHANNEL_ID).catch(() => null);
    if (!xpChannel) {
      console.error('❌ Failed to fetch XP channel.');
      continue;
    }

    try {
      await xpChannel.send('t@score');
      await delay(2000);
      await xpChannel.send('1');
      await delay(2000);
      await xpChannel.send(`<@${userId}>`);
      await delay(2000);
      await xpChannel.send(String(xpAmount));
      await delay(2000);


    } catch (err) {
    }
  }

  processingXP = false;
}

// === Message Event ===
client.on('messageCreate', async (m) => {
  // Ignore unrelated bot messages
  if (m.author.bot && m.author.id !== client.user.id && m.author.id !== '1375977583895773226') return;

  // === Drop XP Command Handler ===
  if (
    m.channel.id === '1252204884426756193' &&
    m.author.id === '1375977583895773226' &&
    m.content.startsWith('!dropclaimed')
  ) {
    const args = m.content.trim().split(/\s+/);
    if (args.length !== 3) return; // Expecting: !dropclaimed <userId> <xpAmount>

    const userId = args[1];
    const xpAmount = parseInt(args[2], 10);
    if (!/^\d{15,20}$/.test(userId) || isNaN(xpAmount)) return;

    xpClaimQueue.push({ userId, xpAmount });

    if (!processingXP) {
      processXPQueue(client);
    }
    return;
  }

  // Ignore other bot messages
  if (m.author.bot && m.author.id !== RIN_APP_ID && m.author.id !== '247283454440374274') return;

  if (await handleBingo(m)) return;

  // Mod command detection
  const modCommand = parseModCommand(m);
  if (modCommand) {
    const member = await m.guild.members.fetch(m.author.id).catch(() => null);
    if (!member) return;

    const authorizedRoles = [
      '1252204883667320886',
      '1364944237069598792',
      '1351661038902181969',
      '1364897584031993973',
      '1364957729675804774',
      '1376534380075421716'
    ];

    const hasRole = authorizedRoles.some(roleId => member?.roles.cache.has(roleId));
    if (!hasRole) {
      console.log(`Unauthorized mod command attempt by ${m.author.tag}`);
      return;
    }

    console.log(`Mod command detected by authorized user ${m.author.tag}!, modCommand`);

    try {
      await postModReport('1356006813815935096', modCommand, client);
    } catch (err) {
      console.error('Failed to post report:', err);
    }
    return;
  }
});

async function getMessageCount(guild, userId) {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return 0;
    // Assume you store this data or implement a fetcher — 
    // for now, return 0 as placeholder until your message count system is wired up
    return 0;
  } catch (e) {
    console.error('Failed to fetch message count:', e);
    return 0;
  }
}

/* ---------- BINGO ---------- */
async function handleBingo(message){
  if (!message.content.startsWith('.bingo')) return false;

  const args = message.content.trim().split(/\s+/);
  if (args.length < 2)
    return message.reply('Usage: .bingo <number> with a CSV file attached');

  if (message.attachments.size === 0)
    return message.reply('Attach the CSV file for this bingo round.');

  const file = message.attachments.first();
  if (!file.name.toLowerCase().endsWith('.csv'))
    return message.reply('That file isn’t a CSV. Please attach a .csv file.');

  let csvText;
  try {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csvText = await res.text();
  } catch (err) {
    console.error('[CSV] fetch error:', err);
    return message.reply('Couldn’t download the CSV attachment.');
  }

  let records;
  try {
    records = csvParse(csvText, { columns: true, skip_empty_lines: true });
  } catch (err) {
    console.error('[CSV] parse error:', err);
    return message.reply('CSV parse failed. Make sure the file is valid.');
  }

  /* --- Build score map --- */
  const scores = {};
  for (const row of records) {
    const uidKey = Object.keys(row).find(k => /user.?id/i.test(k));
    if (!uidKey) continue;

    const id = (row[uidKey] || '').trim();
    if (!/^\d{15,20}$/.test(id)) continue;

    const score = parseInt(Object.values(row)[1], 10); // assumes 2nd column is score
    if (isNaN(score)) continue;
    scores[id] = score;
  }

  /* --- Group by score --- */
  const grouped = {};
  Object.entries(scores).forEach(([id, score]) => {
    (grouped[score] ||= []).push(id);
  });

  const scoreVals = Object.keys(grouped).map(Number);
  const max = Math.max(...scoreVals);
  const min = Math.min(...scoreVals);
  const second = scoreVals.filter(s => s < max && s > 0).sort((a, b) => b - a)[0] ?? 0;

  const topIDs    = grouped[max]   || [];
  const secondIDs = grouped[second]|| [];
  const zeroIDs   = grouped[0]     || [];
  const minIDs    = grouped[min]   || [];

  const guild = message.guild;

  /* --- Remove previous bingo roles --- */
  for (const roleId of [BINGO_STRIKER_ROLE, BENCHWARMER_ROLE, CLOWN_ROLE]) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    for (const member of role.members.values()) {
      await member.roles.remove(roleId).catch(() => {});
    }
  }

  /* --- Assign new bingo roles --- */
  const roleUpdates = {
    striker: [],
    benchwarmer: [],
    clown: [],
  };

  for (const [ids, role, label] of [
    [topIDs, BINGO_STRIKER_ROLE, 'striker'],
    [zeroIDs, BENCHWARMER_ROLE, 'benchwarmer'],
    [minIDs, CLOWN_ROLE, 'clown'],
  ]) {
    for (const id of ids) {
      const m = await guild.members.fetch(id).catch(() => null);
      if (m) {
        await m.roles.add(role).catch(() => {});
        roleUpdates[label].push(`<@${id}>`);
      }
    }
  }

  const xpChannel = await client.channels.fetch(TATSU_CHANNEL_ID);

  const xpUpdates = { '2': [], '1': [] };

  async function giveXp(id, amount) {
    await xpChannel.send('t@score');         await delay(2000);
    await xpChannel.send('1');               await delay(2000);
    await xpChannel.send(`<@${id}>`);        await delay(2000);
    await xpChannel.send(String(amount));    await delay(2000);
    xpUpdates[amount === 2000 ? '2' : '1'].push(`<@${id}>`);
  }

  for (const id of topIDs)    await giveXp(id, 2000);
  for (const id of secondIDs) await giveXp(id, 1000);

  const announce = [];

  if (roleUpdates.striker.length)
    announce.push(`Added **Striker** role to: ${roleUpdates.striker.join(', ')}`);
  if (roleUpdates.benchwarmer.length)
    announce.push(`Added **Benchwarmer** role to: ${roleUpdates.benchwarmer.join(', ')}`);
  if (roleUpdates.clown.length)
    announce.push(`Added **Clown** role to: ${roleUpdates.clown.join(', ')}`);
  if (xpUpdates['2'].length)
    announce.push(`Gave **2000 XP** to: ${xpUpdates['2'].join(', ')}`);
  if (xpUpdates['1'].length)
    announce.push(`Gave **1000 XP** to: ${xpUpdates['1'].join(', ')}`);

  if (announce.length)
    await message.channel.send(announce.join('\n'));

  return true;
}

const topCollector = {
  active: false,
  page: 0,
  ids: [],
  sourceChannel: null, // Track the message origin
};

const ANNOUNCEMENT_CHANNEL_ID = '1252205938689970256';
const SECRET_CHANNEL_ID = '1356564458838949908';
// Run t!top command at 12:26 AM on 20th of each month
// 🕓 Every month on the 20th at 12:26 AM (Halifax time)

client.on('messageCreate', async (message) => {
  // === Ignore other bots ===
  if (message.author.bot && message.author.id !== client.user.id) return;

  // === Treasure Summoning Feature ===

});


// === Duration Formatter ===
function humanizeDuration(dur) {
  if (!dur || dur.toLowerCase() === 'n/a') return 'N/A';
  const match = dur.match(/^(\d+)([smhdw])$/i);
  if (!match) return dur;

  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const unitsMap = {
    s: 'second',
    m: 'minute',
    h: 'hour',
    d: 'day',
    w: 'week',
  };

  let unitStr = unitsMap[unit] || unit;
  if (num !== 1) unitStr += 's';

  return `${num} ${unitStr}`;
}

// === Mod Command Parser ===
function parseModCommand(msg) {
  const regex = /^!(mute|warn|ban)\s+(?:<@!?(\d{15,20})>|(\d{15,20}))\s+([\s\S]+)$/i;
  const match = msg.content.match(regex);
  if (!match) return null;

  const [, command, mentionId, rawId, rest] = match;
  const userId = mentionId || rawId;
  const type = command.toLowerCase();

  let duration = 'N/A';
  let reason = rest;

  const durationMatch = rest.match(/^(\d+)([smhdw])\s+(.*)$/i);
  if (durationMatch) {
    duration = durationMatch[1] + durationMatch[2];
    reason = durationMatch[3];
  }

  return {
    type,
    userId,
    duration,
    reason,
    attachments: [...msg.attachments.values()],
    moderatorId: msg.author.id,
  };
}

// === Persistent modThreads Mapping ===
const modThreadsPath = path.join(__dirname, 'modThreads.json');
let modThreads = {};
if (fs.existsSync(modThreadsPath)) {
  modThreads = JSON.parse(fs.readFileSync(modThreadsPath, 'utf8'));
}
function saveModThreads() {
  fs.writeFileSync(modThreadsPath, JSON.stringify(modThreads, null, 2), 'utf8');
}

// === Persistent Reports Mapping ===


// === Mod Report Poster ===
async function postModReport(forumChannelId, report, client) {
  console.log('Posting mod report:', report);

  const guild = client.guilds.cache.first();
  const forumChannel = await client.channels.fetch(forumChannelId);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
  console.error(`Not a forum channel: got type ${forumChannel?.type}`);
  return;
}

  try {
    const targetUserId = report.userId.trim();

    if (report.type === 'ban' && !modThreads[targetUserId]) {
      const messageCount = await getMessageCount(guild, targetUserId);
      if (messageCount < 1000) {
        const logChannel = await client.channels.fetch('1356009015485796372');
        await logChannel.send(`${targetUserId}\nReason: ${report.reason}\nBanned by <@${report.moderatorId}>`);
        return;
      }
    }

    if (modThreads[targetUserId]) {
      const threadId = modThreads[targetUserId];
      const existingThread = await forumChannel.threads.fetch(threadId).catch(() => null);
      if (existingThread) {
        await sendReportToThread(existingThread, report, client);
        return;
      } else {
        delete modThreads[targetUserId];
        saveModThreads();
      }
    }

    const activeThreads = await forumChannel.threads.fetchActive();
    const allThreads = [...activeThreads.threads.values()];
    let targetThread = allThreads.find(t => t.name === targetUserId);

    if (!targetThread) {
      targetThread = await forumChannel.threads.create({
        name: targetUserId,
        message: { content: `Thread created for user <@${targetUserId}>.` },
      });
    }

    modThreads[targetUserId] = targetThread.id;
    saveModThreads();

    // 🔍 Log current modThreads.json content
    console.log('🔁 Updated modThreads.json content:\n', JSON.stringify(modThreads, null, 2));

    await sendReportToThread(targetThread, report, client);


  } catch (error) {
    console.error('Error posting mod report:', error);
  }
}

// === Report Poster to Thread (with OCR saving) ===
async function sendReportToThread(thread, report, client) {
  const moderator = await client.users.fetch(report.moderatorId).catch(() => null);
  const moderatorName = moderator ? moderator.username : 'Unknown Moderator';

  const content = `**Type:** ${report.type}\n**Moderator:** ${moderatorName}\n**Duration:** ${humanizeDuration(report.duration)}\n**Reason:**`

  const files = report.attachments.map(att => ({ attachment: att.url, name: att.name }));
  await thread.send({ content, files });
}

// === Thread delete monitor ===

function registerThreadDeleteListener(client) {
  client.on('threadDelete', (thread) => {
    const userId = Object.keys(modThreads).find(key => modThreads[key] === thread.id);
    if (userId) {
      console.log(`Thread for user ${userId} was deleted, removing from JSON.`);
      delete modThreads[userId];
      saveModThreads();
    }
  });
}





// 🚀 Start bot

client.login(process.env.DISCORD_TOKEN).catch(console.error);

const app = express();
app.get('/', (req, res) => res.send('Bot is alive.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});

