// Rewritten to use discord.js v14 instead of discord.js-selfbot-v13

import dotenv from 'dotenv';
dotenv.config();

import { joinVoiceChannel } from '@discordjs/voice';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';
import { parse as csvParse } from 'csv-parse/sync';
import { create, all } from 'mathjs';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Tesseract from 'tesseract.js';
import express from 'express';
import sharp from 'sharp';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const Jimp = require('jimp');

const math = create(all);
math.config({ number: 'number', precision: 64 });

const COUNTING_CHANNEL_ID = '1348370380657524896';
const COUNTING_BOT_ID = '510016054391734273';
const MONTHLY_CHANNEL_ID = '1252204884426756193';
const NEW_GEN_ROLE_ID = '1354540452283682967';
const TATSUMAKI_BOT_ID = '172002275412279296';
const BINGO_STRIKER_ROLE = '1374818698334048448';
const BENCHWARMER_ROLE = '1374818741216608469';
const CLOWN_ROLE = '1374818786502246400';
const TATSU_CHANNEL_ID = '1252204884426756193';
const EVOLUTION_CHANNEL_ID = '1388984587237195906';

const STAFF_ROLE_IDS = [
  '1364897584031993973', '1252204883667320885', '1351661038902181969',
  '1252204883667320886', '1351850232337530901', '1364944237069598792',
  '1351853373007335444', '1356635617437548607', '1364957729675804774',
  '1364930057683992637', '1252204883667320889', '1252204883667320890',
  '1358801211901345916'
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User, Partials.GuildMember]
});

const delay = ms => new Promise(r => setTimeout(r, ms));

const RIN_APP_ID = '429656936435286016';
const GUILD_ID = '1252204883533103145';

client.once(Events.ClientReady, () => {
  console.log(`[READY] ${client.user.tag}`);
});

const xpClaimQueue = [];
let processingXP = false;

async function processXPQueue() {
  processingXP = true;

  while (xpClaimQueue.length > 0) {
    const { userId, xpAmount } = xpClaimQueue.shift();
    const xpChannel = await client.channels.fetch(TATSU_CHANNEL_ID).catch(() => null);
    if (!xpChannel) continue;

    try {
      await xpChannel.send('t@score');
      await delay(2000);
      await xpChannel.send('1');
      await delay(2000);
      await xpChannel.send(`<@${userId}>`);
      await delay(2000);
      await xpChannel.send(String(xpAmount));
      await delay(2000);
      console.log(`✅ Gave ${xpAmount} XP to user ${userId}`);
    } catch (err) {
      console.error(`❌ Failed to give XP to ${userId}:`, err);
    }
  }
  processingXP = false;
}

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot && m.author.id !== client.user.id && m.author.id !== '1375977583895773226') return;

  if (
    m.channel.id === TATSU_CHANNEL_ID &&
    m.author.id === '1375977583895773226' &&
    m.content.startsWith('!dropclaimed')
  ) {
    const args = m.content.trim().split(/\s+/);
    if (args.length !== 3) return;
    const userId = args[1];
    const xpAmount = parseInt(args[2], 10);
    if (!/^[0-9]{15,20}$/.test(userId) || isNaN(xpAmount)) return;

    xpClaimQueue.push({ userId, xpAmount });
    if (!processingXP) processXPQueue();
    return;
  }

  if (await handleBingo(m)) return;

  const modCommand = parseModCommand(m);
  if (modCommand) {
    const member = await m.guild.members.fetch(m.author.id).catch(() => null);
    if (!member) return;

    const authorizedRoles = [
      '1252204883667320886', '1364944237069598792', '1351661038902181969',
      '1364897584031993973', '1364957729675804774', '1376534380075421716'
    ];

    const hasRole = authorizedRoles.some(roleId => member.roles.cache.has(roleId));
    if (!hasRole) return;

    try {
      await postModReport('1356006813815935096', modCommand);
    } catch (err) {
      console.error('Failed to post report:', err);
    }
    return;
  }
});

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

function humanizeDuration(dur) {
  if (!dur || dur.toLowerCase() === 'n/a') return 'N/A';
  const match = dur.match(/^(\d+)([smhdw])$/i);
  if (!match) return dur;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const unitsMap = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week' };
  let unitStr = unitsMap[unit] || unit;
  if (num !== 1) unitStr += 's';
  return `${num} ${unitStr}`;
}

async function postModReport(forumChannelId, report) {
  const forumChannel = await client.channels.fetch(forumChannelId);
  if (!forumChannel || forumChannel.type !== 15) return; // GUILD_FORUM = 15

  const targetUserId = report.userId.trim();
  const thread = await forumChannel.threads.create({
    name: targetUserId,
    message: { content: `Thread created for user <@${targetUserId}>.` },
  });

  const moderator = await client.users.fetch(report.moderatorId).catch(() => null);
  const moderatorName = moderator ? moderator.username : 'Unknown Moderator';
  const content = `**Type:** ${report.type}\n**Moderator:** ${moderatorName}\n**Duration:** ${humanizeDuration(report.duration)}\n**Reason:** ${report.reason}`;

  const files = report.attachments.map(att => ({ attachment: att.url, name: att.name }));
  await thread.send({ content, files });
}

// Keep-alive express server
const app = express();
app.get('/', (_, res) => res.send('Bot is alive.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Keep-alive server running on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
