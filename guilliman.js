// index.js
// Discord Server Index Bot — Full Implementation with 11 Factors

// ===== Imports =====
import {
  Client,
  GatewayIntentBits,
  Partials,
  AttachmentBuilder,
  EmbedBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  AuditLogEvent
} from 'discord.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { createObjectCsvWriter } from 'csv-writer';
import csv from 'csv-parser';
import fs from 'fs';
import cron from 'node-cron';
import dotenv from 'dotenv';
import Chart from 'chart.js/auto';
import express from 'express';

dotenv.config();





// ===== CONFIG =====
const TOKEN = process.env.TOKEN;             // set in env
const GUILD_ID = "1252204883533103145";      // target guild
const EVENT_ROLE_ID = "1252204883533103153"; // role mention triggers event factor
const csvFilePath = './server_index.csv';
const stateFilePath = './activity_state.json';

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// ===== CSV Writer/Reader =====
const csvWriter = createObjectCsvWriter({
  path: csvFilePath,
  header: [
    { id: 'date',  title: 'Date' },
    { id: 'index', title: 'IndexValue' }
  ],
  append: fs.existsSync(csvFilePath)
});

async function saveIndexValue(date, indexValue) {
  await csvWriter.writeRecords([{ date, index: indexValue }]);
  console.log(`✅ Saved index for ${date}: ${indexValue}`);
}

async function readIndexData() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(csvFilePath)) return resolve({ dates: [], values: [] });

    const results = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv({ headers: ['Date', 'IndexValue'] }))
      .on('data', (data) => results.push(data))
      .on('end', () => {
        const dates = results.map(r => r.Date);
        const values = results.map(r => parseFloat(r.IndexValue));
        resolve({ dates, values });
      })
      .on('error', reject);
  });
}

// ===== Activity State (Persistent) =====
const defaultState = {
  joins: [],          // ts[]
  leaves: [],         // ts[]
  messages: [],       // {ts, channelId, userId}
  reactions: [],      // {ts, messageId, userId}
  voiceSessions: [],  // {userId, startedAt, endedAt, durationMs}
  boosts: [],         // ts[]
  eventMentions: [],  // ts[]
  deletes: [],        // ts[]
  kicks: [],          // ts[]
  bans: [],           // ts[]
  lastActivity: {},   // userId -> ts
  memberJoins: {},    // userId -> joinTs
  shortChurn: 0,      // members who left < 7 days
  lastKickAuditId: null // last seen kick audit log id
};

let state = defaultState;
let voiceActive = {}; // userId -> startTs

function loadState() {
  try {
    if (fs.existsSync(stateFilePath)) {
      const file = fs.readFileSync(stateFilePath, 'utf8');
      state = Object.assign({}, defaultState, JSON.parse(file));
      console.log('🗂️  Loaded activity state.');
    }
  } catch (e) {
    console.error('⚠️ Failed to load state, starting fresh.', e);
  }
}
function saveState() {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state));
  } catch (e) {
    console.error('⚠️ Failed to save state.', e);
  }
}

// ===== Helpers =====
const MS = {
  minute: 60 * 1000,
  hour:   60 * 60 * 1000,
  day:    24 * 60 * 60 * 1000,
  week:   7 * 24 * 60 * 60 * 1000
};

function nowTs() { return Date.now(); }

function pruneOldState(maxAgeMs = 365 * MS.day) {
  const cutoff = nowTs() - maxAgeMs;
  const keepRecent = arr => arr.filter(x => (x.ts ?? x) >= cutoff);

  state.joins         = keepRecent(state.joins.map(ts => ({ts}))).map(x => x.ts);
  state.leaves        = keepRecent(state.leaves.map(ts => ({ts}))).map(x => x.ts);
  state.messages      = keepRecent(state.messages);
  state.reactions     = keepRecent(state.reactions);
  state.voiceSessions = keepRecent(state.voiceSessions);
  state.boosts        = keepRecent(state.boosts.map(ts => ({ts}))).map(x => x.ts);
  state.eventMentions = keepRecent(state.eventMentions.map(ts => ({ts}))).map(x => x.ts);
  state.deletes       = keepRecent(state.deletes.map(ts => ({ts}))).map(x => x.ts);
  state.kicks         = keepRecent(state.kicks.map(ts => ({ts}))).map(x => x.ts);
  state.bans          = keepRecent(state.bans.map(ts => ({ts}))).map(x => x.ts);

  // lastActivity/memberJoins entries older than a year can be trimmed
  for (const [userId, ts] of Object.entries(state.lastActivity)) {
    if (ts < cutoff) delete state.lastActivity[userId];
  }
  for (const [userId, ts] of Object.entries(state.memberJoins)) {
    if (ts < cutoff) delete state.memberJoins[userId];
  }
}

// Normalize to 0..100
function normalize(value, min, max) {
  if (max === min) return 50;
  const v = Math.max(min, Math.min(max, value));
  return ((v - min) / (max - min)) * 100;
}
// Inverse normalize (higher is worse → penalty)
function normalizeInverse(value, min, max) {
  return 100 - normalize(value, min, max);
}
// Safe divide
function div(a, b) { return b ? a / b : 0; }

// Rollup helpers within a time window
function countSince(arr, ms) {
  const cutoff = nowTs() - ms;
  return arr.filter(ts => ts >= cutoff).length;
}
function sumVoiceSince(ms) {
  const cutoff = nowTs() - ms;
  return state.voiceSessions
    .filter(s => (s.endedAt ?? nowTs()) >= cutoff)
    .reduce((acc, s) => acc + (s.durationMs || 0), 0);
}
function activeChannelsSince(ms) {
  const cutoff = nowTs() - ms;
  const set = new Set();
  for (const m of state.messages) if (m.ts >= cutoff) set.add(m.channelId);
  return set.size;
}

// ===== Metric Calculation =====
// Window used for index (last 24h by default)
const INDEX_WINDOW = MS.day;

// Weightings for the 11 factors (sum around 1.0)
const WEIGHTS = {
  growth:       0.12,
  engagement:   0.16,
  voice:        0.10,
  boost:        0.08,
  inactivity:   0.10, // penalty
  spread:       0.07,
  retention:    0.10,
  event:        0.07,
  moderation:   0.07, // penalty
  consistency:  0.06,
  momentum:     0.07
};

// Growth Factor (joins − leaves, normalized)
function calcGrowth(joins, leaves, maxExpected = 50) {
  const net = Math.max(0, joins - leaves);  // prevent negatives
  return Math.min(1, net / maxExpected);    // normalize to 0–1
}

// Engagement Factor (messages + reactions)
function calcEngagement(messages, reactions, maxExpected = 500) {
  const total = messages + reactions;
  return Math.min(1, total / maxExpected);
}

// Voice Factor (minutes spent in VC → fractional hours)
function calcVoice(totalMinutes, maxExpectedHours = 200) {
  const hours = totalMinutes / 60;
  return Math.min(1, hours / maxExpectedHours);
}

// Boost Factor (new boosts + tier upgrades)
function calcBoost(boosts, upgrades, maxExpected = 10) {
  const total = boosts + upgrades;
  return Math.min(1, total / maxExpected);
}

// Inactivity Penalty (% inactive members)
function calcInactivity(inactiveMembers, totalMembers) {
  if (totalMembers === 0) return 0;
  const percentInactive = inactiveMembers / totalMembers; // 0–1
  return 1 - percentInactive; // higher inactivity → lower score
}

// Spread Factor (active channels ÷ total channels)
function calcSpread(activeChannels, totalChannels) {
  if (totalChannels === 0) return 0;
  return activeChannels / totalChannels; // already 0–1
}

// Retention Factor (% of members staying ≥ 7 days)
function calcRetention(retained, joined) {
  if (joined === 0) return 0;
  return retained / joined; // 0–1 fraction
}

// Event Factor (mentions of special role)
function calcEvent(eventMentions, maxExpected = 20) {
  return Math.min(1, eventMentions / maxExpected);
}

// Moderation Load (penalty for moderation actions)
function calcModeration(kicks, bans, deletes, maxExpected = 50) {
  const total = kicks + bans + deletes;
  return 1 - Math.min(1, total / maxExpected); // more actions = lower score
}

// Consistency Factor (variance of activity)
function calcConsistency(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a,b) => a+b, 0) / values.length;
  const variance = values.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  // Normalize: lower stddev = more consistent
  return 1 / (1 + stddev); // stays in 0–1
}

// Momentum (today ÷ lastWeekAvg)
function calcMomentum(todayActivity, lastWeekAvg) {
  if (lastWeekAvg === 0) return 1; // avoid divide by zero, neutral score
  const ratio = todayActivity / lastWeekAvg;
  return Math.min(1, ratio); // cap at 1
}


// Main function to compute 0..1000 index
async function computeServerIndex(guild) {
  const windowMs = INDEX_WINDOW;

  // 1) Growth Factor (joins − leaves)
  const joins = countSince(state.joins, windowMs);
  const leaves = countSince(state.leaves, windowMs);
  const growthRaw = joins - leaves;
  const growthScore = normalize(growthRaw, -20, 50);

  // 2) Engagement (messages + reactions)
  const msgs = state.messages.filter(m => m.ts >= nowTs() - windowMs).length;
  const reacts = state.reactions.filter(r => r.ts >= nowTs() - windowMs).length;
  const engagementScore = normalize(msgs + reacts, 0, 2000);

  // 3) Voice (fractional hours from milliseconds)
  const voiceMs = sumVoiceSince(windowMs);
  const voiceHours = voiceMs / MS.hour;  
  const voiceScore = normalize(voiceHours, 0, 50);

  // 4) Boosts
  const boosts = countSince(state.boosts, windowMs);
  const boostScore = normalize(boosts, 0, 10);

  // 5) Inactivity penalty
  let inactivityPct = 0;
  try {
    const members = await guild.members.fetch({ withPresences: false });
    const total = members.size || 1;
    const sevenDaysAgo = nowTs() - 7 * MS.day;
    let inactive = 0;
    for (const m of members.values()) {
      const last = state.lastActivity[m.id] || 0;
      if (last < sevenDaysAgo) inactive++;
    }
    inactivityPct = (inactive / total) * 100;
  } catch (e) {
    inactivityPct = 50; // default if fetch fails
  }
  const inactivityScore = normalizeInverse(inactivityPct, 0, 80);

  // 6) Channel Spread
  let spreadScore = 50;
  try {
    const active = activeChannelsSince(windowMs);
    const channels = await guild.channels.fetch();
    const totalText = channels.filter(c => c && c.isTextBased && c.isTextBased()).size || 1;
    spreadScore = normalize(active / totalText, 0, 0.7);
  } catch {}

  // 7) Retention (stayed ≥ 7 days)
  const joins7d = countSince(state.joins, 7 * MS.day);
  const shortChurn = state.shortChurn || 0;
  const retentionPct = joins7d ? Math.max(0, 100 * (1 - shortChurn / joins7d)) : 100;
  const retentionScore = normalize(retentionPct, 60, 100);

  // 8) Event Factor (role mentions)
  const eventCount = countSince(state.eventMentions, windowMs);
  const eventScore = normalize(eventCount, 0, 30);

  // 9) Moderation load penalty
  const modCount =
    countSince(state.kicks, windowMs) +
    countSince(state.bans, windowMs) +
    countSince(state.deletes, windowMs);
  const moderationScore = normalizeInverse(modCount, 0, 200);

  // 10) Consistency (variance of hourly messages, 7d)
  const perHourCounts = hourlyBuckets(state.messages, 7 * MS.day);
  const variance = calcVariance(perHourCounts);
  const consistencyScore = normalizeInverse(variance, 0, 400);

  // 11) Momentum (today vs last week avg)
  const todayMsgs = state.messages.filter(m => m.ts >= nowTs() - MS.day).length;
  const todayVoiceH = sumVoiceSince(MS.day) / MS.hour;
  const todayActivity = todayMsgs + todayVoiceH * 30;
  const weekMsgs = state.messages.filter(m => m.ts >= nowTs() - 7 * MS.day).length - todayMsgs;
  const weekVoiceH = (sumVoiceSince(7 * MS.day) / MS.hour) - todayVoiceH;
  const weekAvg = (weekMsgs + weekVoiceH * 30) / 6;
  const momentumRatio = weekAvg > 0 ? todayActivity / weekAvg : 1;
  const momentumScore = normalize(momentumRatio, 0.5, 2.0);

  // Weighted sum → 0..100
  const score0to100 =
    growthScore      * WEIGHTS.growth +
    engagementScore  * WEIGHTS.engagement +
    voiceScore       * WEIGHTS.voice +
    boostScore       * WEIGHTS.boost +
    inactivityScore  * WEIGHTS.inactivity +
    spreadScore      * WEIGHTS.spread +
    retentionScore   * WEIGHTS.retention +
    eventScore       * WEIGHTS.event +
    moderationScore  * WEIGHTS.moderation +
    consistencyScore * WEIGHTS.consistency +
    momentumScore    * WEIGHTS.momentum;

  // Map 0..100 → 0..1000
  const indexValue = Math.round(score0to100 * 10);
  return indexValue;
} 

function hourlyBuckets(messages, windowMs) {
  const cutoff = nowTs() - windowMs;
  const hours = {};
  for (const m of messages) {
    if (m.ts < cutoff) continue;
    const h = Math.floor(m.ts / MS.hour) * MS.hour;
    hours[h] = (hours[h] || 0) + 1;
  }
  return Object.values(hours);
}
function calcVariance(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((a,b)=>a+b,0) / arr.length;
  return arr.reduce((acc,v)=>acc+(v-mean)*(v-mean),0) / arr.length;
}

// ===== Event Capture =====
client.on('guildMemberAdd', member => {
  if (member.guild.id !== GUILD_ID) return;
  const ts = nowTs();
  state.joins.push(ts);
  state.memberJoins[member.id] = ts;
  state.lastActivity[member.id] = ts;
  saveState();
});

client.on('guildMemberRemove', member => {
  if (member.guild.id !== GUILD_ID) return;
  const ts = nowTs();
  state.leaves.push(ts);
  const joinTs = state.memberJoins[member.id];
  if (joinTs && (ts - joinTs) < 7 * MS.day) state.shortChurn += 1;
  delete state.memberJoins[member.id];
  saveState();
});

client.on('messageCreate', msg => {
  if (!msg.guild || msg.guild.id !== GUILD_ID) return;
  if (msg.author?.bot) return;
  const ts = nowTs();
  state.messages.push({ ts, channelId: msg.channelId, userId: msg.author.id });
  state.lastActivity[msg.author.id] = ts;

  // Event factor: role mention?
  if (msg.mentions?.roles?.has(EVENT_ROLE_ID)) {
    state.eventMentions.push(ts);
  }
  saveState();
});

client.on('messageReactionAdd', (reaction, user) => {
  if (!reaction.message?.guild || reaction.message.guild.id !== GUILD_ID) return;
  if (user?.bot) return;
  state.reactions.push({ ts: nowTs(), messageId: reaction.message.id, userId: user.id });
  state.lastActivity[user.id] = nowTs();
  saveState();
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (newState.guild.id !== GUILD_ID) return;
  const userId = newState.id;
  const now = nowTs();

  const wasIn = !!oldState.channelId;
  const isIn  = !!newState.channelId;

  if (!wasIn && isIn) {
    // joined
    voiceActive[userId] = now;
    state.lastActivity[userId] = now;
  } else if (wasIn && !isIn) {
    // left
    const start = voiceActive[userId];
    if (start) {
      const durationMs = now - start;
      state.voiceSessions.push({ userId, startedAt: start, endedAt: now, durationMs });
      delete voiceActive[userId];
      saveState();
    }
  } else if (wasIn && isIn && oldState.channelId !== newState.channelId) {
    // moved channels: close previous, start new
    const start = voiceActive[userId];
    if (start) {
      const durationMs = now - start;
      state.voiceSessions.push({ userId, startedAt: start, endedAt: now, durationMs });
    }
    voiceActive[userId] = now;
    state.lastActivity[userId] = now;
    saveState();
  }
});

// Boosts: detect when a member starts boosting
client.on('guildMemberUpdate', (oldM, newM) => {
  if (newM.guild.id !== GUILD_ID) return;
  try {
    const had = !!oldM.premiumSince;
    const has = !!newM.premiumSince;
    if (!had && has) state.boosts.push(nowTs());
    saveState();
  } catch {}
});

// Bans
client.on('guildBanAdd', ban => {
  if (ban.guild.id !== GUILD_ID) return;
  state.bans.push(nowTs());
  saveState();
});

// Message deletes
client.on('messageDelete', msg => {
  if (!msg.guild || msg.guild.id !== GUILD_ID) return;
  state.deletes.push(nowTs());
  saveState();
});

// Poll kicks via audit logs (no native event)
async function pollKicks(guild) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 10 });
    const entries = Array.from(logs.entries.values()); // newest first
    for (const entry of entries.reverse()) {
      if (state.lastKickAuditId && entry.id <= state.lastKickAuditId) continue;
      state.kicks.push(new Date(entry.createdAt).getTime());
      state.lastKickAuditId = entry.id;
    }
    saveState();
  } catch (e) {
    console.warn('Kick audit log fetch failed (need permissions?):', e.message);
  }
}

// ===== Index Stats Helper =====
function calculateIndexStats(dates, values) {
  if (!dates.length || !values.length) return null;
  
  const currentIndex = values[values.length - 1];
  
  // Find index from 24 hours ago
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  
  let previousIndex = null;
  let percentChange = null;
  let trend = null;
  
  // Find the closest index value from ~24 hours ago
  for (let i = dates.length - 1; i >= 0; i--) {
    const dateTs = new Date(dates[i]).getTime();
    if (dateTs <= oneDayAgo) {
      previousIndex = values[i];
      break;
    }
  }
  
  if (previousIndex !== null && previousIndex > 0) {
    percentChange = ((currentIndex - previousIndex) / previousIndex) * 100;
    trend = percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'stable';
  }
  
  return {
    current: currentIndex,
    previous: previousIndex,
    percentChange,
    trend
  };
}

function formatIndexStats(stats) {
  if (!stats) return 'Current Index: N/A';
  
  let description = `**Current Index:** ${stats.current}/1000`;
  
  if (stats.percentChange !== null) {
    const absChange = Math.abs(stats.percentChange);
    const emoji = stats.trend === 'up' ? '📈' : stats.trend === 'down' ? '📉' : '➡️';
    const sign = stats.percentChange > 0 ? '+' : '';
    
    description += ` ${emoji} ${sign}${stats.percentChange.toFixed(1)}% (24h)`;
  }
  
  return description;
}

// ===== Chart Generator (Fancy) =====
const width = 1200;
const height = 600;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: '#0b1220' });

async function generateServerIndexChart(dates, values, subtitle = '', timeRange = null) {
  const configuration = {
    type: 'line',
    data: {
      labels: dates.map(d => new Date(d)), // ensure parsed as Date objects
      datasets: [{
          label: 'Server Index',
          data: values,
          borderColor: '#38bdf8', // cyan-400
          borderWidth: 4,
          tension: 0.4,
          fill: true,
          backgroundColor: (ctx) => {
            const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
            g.addColorStop(0, 'rgba(56,189,248,0.4)');   // cyan
            g.addColorStop(0.5, 'rgba(139,92,246,0.25)'); // violet
            g.addColorStop(1, 'rgba(0,0,0,0)');
            return g;
          },
          pointRadius: 4,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#38bdf8',
          pointHoverRadius: 7
        }]
    },
    options: {
      responsive: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: '✨ Server Performance Index',
          color: '#ffffff',
          font: { size: 28, weight: 'bold' }
        },
        subtitle: {
          display: !!subtitle,
          text: subtitle,
          color: '#cbd5e1',
          font: { size: 16 }
        },
        tooltip: {
          mode: 'nearest',
          intersect: false,
          backgroundColor: '#111827',
          titleColor: '#ffffff',
          bodyColor: '#d1d5db'
        }
      },
      scales: {
          x: {
              ticks: {
                color: '#ffffff',
                font: { size: 14, weight: 'bold' },
                maxTicksLimit: 8,
                callback: (val, index) => {
                  const d = new Date(dates[index]);
                  if (!d || isNaN(d)) return '';
                  
                  // Adaptive labeling based on time range
                  if (timeRange) {
                    const hours = timeRange / (60 * 60 * 1000);
                    const days = timeRange / (24 * 60 * 60 * 1000);
                    const months = timeRange / (30 * 24 * 60 * 60 * 1000);
                    
                    if (hours <= 2) { // 30m, 1h, 2h
                      return d.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit'
                      });
                    } else if (hours <= 24) { // 4h, 12h, 1d
                      return d.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit'
                      });
                    } else if (days <= 7) { // 3d, 7d
                      return d.toLocaleDateString('en-US', { 
                        weekday: 'short',
                        hour: '2-digit'
                      });
                    } else if (days <= 30) { // 2w, 1mo
                      return d.toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric'
                      });
                    } else if (months <= 6) { // 3mo, 6mo
                      return d.toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric'
                      });
                    } else if (months <= 12) { // 1y
                      return d.toLocaleDateString('en-US', { 
                        month: 'short',
                        year: '2-digit'
                      });
                    } else { // 2y, 5y
                      return d.toLocaleDateString('en-US', { 
                        month: 'short',
                        year: 'numeric'
                      });
                    }
                  }
                  
                  // Default fallback
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
              },
              grid: { color: 'rgba(148,163,184,0.15)' }
            },
        y: {
          min: 0,
          max: 1000,
          ticks: { color: '#ffffff', font: { size: 14, weight: 'bold' } },
          grid: { color: 'rgba(148,163,184,0.1)' }
        }
      }
    }
  };

  return await chartJSNodeCanvas.renderToBuffer(configuration);
}



// ===== Time Range Dropdown =====
const ranges = {
  "30m": 30 * MS.minute,
  "1h":  MS.hour,
  "4h":  4 * MS.hour,
  "12h": 12 * MS.hour,
  "1d":  MS.day,
  "3d":  3 * MS.day,
  "7d":  7 * MS.day,
  "2w":  14 * MS.day,
  "1mo": 30 * MS.day,
  "3mo": 90 * MS.day,
  "6mo": 180 * MS.day,
  "1y":  365 * MS.day,
  "2y":  2 * 365 * MS.day,
  "5y":  5 * 365 * MS.day
};

function filterData(dates, values, rangeKey) {
  if (!ranges[rangeKey]) return { dates, values };
  const cutoff = Date.now() - ranges[rangeKey];
  const outD = [];
  const outV = [];
  
  // Create a map to deduplicate entries that are very close in time
  const dataMap = new Map();
  
  // Determine aggregation window based on range
  const rangeMs = ranges[rangeKey];
  let aggregationWindow;
  
  if (rangeMs <= 2 * 60 * 60 * 1000) { // <= 2 hours: keep per minute
    aggregationWindow = 60 * 1000;
  } else if (rangeMs <= 24 * 60 * 60 * 1000) { // <= 1 day: keep per 5 minutes
    aggregationWindow = 5 * 60 * 1000;
  } else if (rangeMs <= 7 * 24 * 60 * 60 * 1000) { // <= 1 week: keep per hour
    aggregationWindow = 60 * 60 * 1000;
  } else if (rangeMs <= 30 * 24 * 60 * 60 * 1000) { // <= 1 month: keep per 6 hours
    aggregationWindow = 6 * 60 * 60 * 1000;
  } else if (rangeMs <= 365 * 24 * 60 * 60 * 1000) { // <= 1 year: keep per day
    aggregationWindow = 24 * 60 * 60 * 1000;
  } else { // > 1 year: keep per week
    aggregationWindow = 7 * 24 * 60 * 60 * 1000;
  }
  
  for (let i = 0; i < dates.length; i++) {
    const ts = new Date(dates[i]).getTime();
    if (ts >= cutoff) {
      // Round to aggregation window for deduplication
      const roundedTs = Math.floor(ts / aggregationWindow) * aggregationWindow;
      // Keep the latest value for each window
      if (!dataMap.has(roundedTs) || ts > dataMap.get(roundedTs).originalTs) {
        dataMap.set(roundedTs, { 
          date: dates[i], 
          value: values[i], 
          originalTs: ts 
        });
      }
    }
  }
  
  // Convert back to arrays, sorted by timestamp
  const sortedEntries = Array.from(dataMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([_, data]) => data);
    
  return { 
    dates: sortedEntries.map(d => d.date), 
    values: sortedEntries.map(d => d.value) 
  };
}

// ===== Slash Command =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.guildId !== GUILD_ID) return interaction.reply("This command only works in the target server.");

  if (interaction.commandName === 'serverindex') {
    await interaction.deferReply();
    const { dates, values } = await readIndexData();
    if (!dates.length) return interaction.editReply("No index data logged yet.");

    const stats = calculateIndexStats(dates, values);
    const statsText = formatIndexStats(stats);
    
    const image = await generateServerIndexChart(dates, values, 'Use the dropdown to change time range');
    const attachment = new AttachmentBuilder(image, { name: 'server-index.png' });

    const now = new Date();
    const timeString = now.toLocaleString('en-US', { timeZone: 'UTC' });

    const embed = new EmbedBuilder()
      .setTitle('Server Index')
      .setDescription(`${statsText}\n\nPerformance index computed from various server stats`)
      .setColor('#3b82f6')
      .setImage('attachment://server-index.png')
      .setFooter({ text: `Generated at: ${timeString} UTC` });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('time_range_select')
      .setPlaceholder('Select time range')
      .addOptions([
        { label: 'Last 30 minutes', value: '30m' },
        { label: 'Last 1 hour', value: '1h' },
        { label: 'Last 4 hours', value: '4h' },
        { label: 'Last 12 hours', value: '12h' },
        { label: 'Last 1 day', value: '1d' },
        { label: 'Last 3 days', value: '3d' },
        { label: 'Last 7 days', value: '7d' },
        { label: 'Last 2 weeks', value: '2w' },
        { label: 'Last 1 month', value: '1mo' },
        { label: 'Last 3 months', value: '3mo' },
        { label: 'Last 6 months', value: '6mo' },
        { label: 'Last 1 year', value: '1y' },
        { label: 'Last 2 years', value: '2y' },
        { label: 'Last 5 years', value: '5y' },
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({
      embeds: [embed],
      files: [attachment],
      components: [row]
    });
  }
});

// Handle dropdown updates
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'time_range_select') return;

  // Check if interaction has already been replied to or deferred
  if (interaction.replied || interaction.deferred) {
    console.log('Interaction already handled, skipping');
    return;
  }

  try {
    // Check if interaction is still valid (not expired)
    const interactionAge = Date.now() - interaction.createdTimestamp;
    if (interactionAge > 14 * 60 * 1000) {
      console.log(`Interaction expired (${Math.floor(interactionAge / 1000)}s old)`);
      if (!interaction.replied && !interaction.deferred) {
        return await interaction.reply({ 
          content: "This interaction has expired. Please run the command again.", 
          ephemeral: true 
        });
      }
      return;
    }

    // Defer the reply immediately to prevent timeout
    await interaction.deferUpdate();

    const selected = interaction.values[0];
    const { dates, values } = await readIndexData();
    
    if (!dates.length) {
      return await interaction.editReply({ 
        content: "No data available.", 
        embeds: [], 
        files: [], 
        components: [] 
      });
    }

    const { dates: d2, values: v2 } = filterData(dates, values, selected);
    if (!d2.length) {
      return await interaction.editReply({ 
        content: "No data for this time range.", 
        embeds: [], 
        files: [], 
        components: [] 
      });
    }

    const labelMap = {
      '30m': 'Last 30 minutes', '1h': 'Last 1 hour', '4h': 'Last 4 hours', '12h': 'Last 12 hours',
      '1d': 'Last 1 day', '3d': 'Last 3 days', '7d': 'Last 7 days', '2w': 'Last 2 weeks',
      '1mo': 'Last 1 month', '3mo': 'Last 3 months', '6mo': 'Last 6 months',
      '1y': 'Last 1 year', '2y': 'Last 2 years', '5y': 'Last 5 years'
    };

    // Calculate stats for the filtered data, but use original data for 24h comparison
    const stats = calculateIndexStats(dates, values);
    const statsText = formatIndexStats(stats);

    const image = await generateServerIndexChart(d2, v2, labelMap[selected] || selected, ranges[selected]);
    const attachment = new AttachmentBuilder(image, { name: 'server-index.png' });

    const now = new Date();
    const timeString = now.toLocaleString('en-US', { timeZone: 'UTC' });

    const embed = new EmbedBuilder()
      .setTitle(`Server Index`)
      .setDescription(`${statsText}\n\nPerformance index • ${labelMap[selected] || selected}`)
      .setColor('#3b82f6')
      .setImage('attachment://server-index.png')
      .setFooter({ text: `Generated at: ${timeString} UTC` });

    await interaction.editReply({
      embeds: [embed],
      files: [attachment],
      components: [interaction.message.components[0]]
    });
    
  } catch (error) {
    console.error('Interaction update error:', error);
    
    // Handle different error scenarios
    if (error.code === 10062) {
      console.log('Unknown interaction error - interaction may have expired');
      return; // Don't try to respond to expired interactions
    }
    
    // Try to respond with error message if we haven't responded yet
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ 
          content: "An error occurred while updating the chart. Please try again.", 
          ephemeral: true 
        });
      } else if (interaction.deferred) {
        await interaction.editReply({ 
          content: "An error occurred while generating the chart. Please try again.",
          embeds: [],
          files: [],
          components: []
        });
      }
    } catch (responseError) {
      console.error('Failed to send error response:', responseError);
    }
  }
});

// ===== Command Registration =====
async function registerCommands() {
  const commands = [
    { name: 'serverindex', description: 'Show the server index graph' }
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log("⏳ Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Error registering commands:", err);
  }
}

// ===== Index Cron: compute & log every minute =====
cron.schedule('*/1 * * * *', async () => {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return console.log("⚠️ Target guild not found.");

    pruneOldState();
    await pollKicks(guild);

    const idx = await computeServerIndex(guild);
    await saveIndexValue(new Date().toISOString(), idx);
  } catch (e) {
    console.error('Index cron failed:', e);
  }
});

// ===== Ready/Login =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // === Every 10 minutes: update status + upload CSV ===
cron.schedule("*/10 * * * *", async () => {
  try {
    const stats = fs.statSync("server_index.csv");
    const sizeInGB = (stats.size / (1024 ** 3)).toFixed(2); // convert bytes → GB

    // Update bot presence
    client.user.setPresence({
      activities: [{ name: `with ${sizeInGB} GB worth of data`, type: 0 }],
      status: "online"
    });

    // Upload CSV to target channel
    const channel = await client.channels.fetch("1252204884426756193");
    if (channel) {
      await channel.send({
        content: `(${new Date().toLocaleString()})`,
        files: ["server_index.csv"]
      });
      console.log("✅ Uploaded CSV snapshot to channel.");
    }
  } catch (err) {
    console.error("❌ Failed to update status/upload CSV:", err);
  }
});


  loadState();
  await registerCommands();

  // Initial kick audit baseline
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) await pollKicks(guild);
});
client.login(TOKEN);

const app = express();
app.get('/', (req, res) => res.send('Bot is alive.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`Keep-alive server running on port ${PORT}`);
});
