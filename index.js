import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import PDFDocument from "pdfkit";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  AttachmentBuilder,
} from "discord.js";

// ========= CONFIG =========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID;
const UPDATE_STOCK_CHANNEL_ID = process.env.UPDATE_STOCK_CHANNEL_ID;
const TESTIMONI_CHANNEL_ID = process.env.TESTIMONI_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_GROUP_ID = 819348691;
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE;

const SEABANK_ACCOUNT = process.env.SEABANK_ACCOUNT || "ISI_REKENING";
const SEABANK_NAME = process.env.SEABANK_NAME || "ISI_NAMA_REKENING";

const ELIGIBLE_DAYS = Number(process.env.ELIGIBLE_DAYS || 14);
const PRICE_PER_1000 = Number(process.env.PRICE_PER_1000 || 100000);
const AUTO_CLOSE_MINUTES = Number(process.env.AUTO_CLOSE_MINUTES || 30);

const STORE_NAME = process.env.STORE_NAME || "OLENG BEACH";
const STORE_FOOTER = process.env.STORE_FOOTER || "OLENG BEACH — Invoice System";
const STOCK_REFRESH_MINUTES = Number(process.env.STOCK_REFRESH_MINUTES || 2);

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!PANEL_CHANNEL_ID) throw new Error("Missing PANEL_CHANNEL_ID");
if (!UPDATE_STOCK_CHANNEL_ID) throw new Error("Missing UPDATE_STOCK_CHANNEL_ID");
if (!TESTIMONI_CHANNEL_ID) throw new Error("Missing TESTIMONI_CHANNEL_ID");
if (!TICKET_CATEGORY_ID) throw new Error("Missing TICKET_CATEGORY_ID");
if (!STAFF_ROLE_ID) throw new Error("Missing STAFF_ROLE_ID");
if (!ROBLOX_API_KEY) throw new Error("Missing ROBLOX_API_KEY");
if (!ROBLOX_COOKIE) throw new Error("Missing ROBLOX_COOKIE (.ROBLOSECURITY)");

// ========= STORAGE =========
const DATA_FILE = path.resolve("./orders.json");
/** @type {Map<string, any>} */
const orders = new Map();

// ========= ORDER CREATION LOCK (ANTI RACE CONDITION) =========
let orderCreationLock = Promise.resolve();

async function withOrderCreationLock(task) {
  const previousLock = orderCreationLock;

  let releaseCurrentLock;
  orderCreationLock = new Promise((resolve) => {
    releaseCurrentLock = resolve;
  });

  await previousLock;

  try {
    return await task();
  } finally {
    releaseCurrentLock();
  }
}

function loadOrders() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const o of arr) {
        normalizeLoadedOrder(o);
        orders.set(o.orderId, o);
      }
    }
  } catch (e) {
    console.error("Failed to load orders.json:", e);
  }
}

function saveOrders() {
  try {
    const arr = Array.from(orders.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error("Failed to save orders.json:", e);
  }
}

function normalizeLoadedOrder(order) {
  if (!order) return;

  if (!order.lastActivityAt) {
    order.lastActivityAt = order.createdAt || nowIso();
  }

  if (typeof order.autoClosePaused !== "boolean") {
    order.autoClosePaused = false;
  }

  const fullyClosedStatuses = ["CLOSED", "CANCELLED", "EXPIRED"];

  if (typeof order.autoCloseEnabled !== "boolean") {
    order.autoCloseEnabled = !fullyClosedStatuses.includes(order.status);
  }

  if (!order.autoCloseDeadlineAt && order.autoCloseEnabled) {
    const base = order.lastActivityAt || order.createdAt || nowIso();

    if (
      order.status === "AWAITING_PAYMENT" ||
      order.status === "AWAITING_PROOF" ||
      order.status === "DONE" ||
      order.status === "INELIGIBLE"
    ) {
      order.autoCloseDeadlineAt = new Date(
        new Date(base).getTime() + AUTO_CLOSE_MINUTES * 60 * 1000
      ).toISOString();
    }
  }

  if (order.status === "PROOF_SUBMITTED") {
    order.autoCloseEnabled = false;
    order.autoCloseDeadlineAt = null;
  }

  if (fullyClosedStatuses.includes(order.status)) {
    order.autoCloseEnabled = false;
    order.autoCloseDeadlineAt = null;
  }
}

function newOrderId() {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `T-${n}`;
}

function fmtIDR(n) {
  return new Intl.NumberFormat("id-ID").format(Number(n || 0));
}

function fmtDateID(d) {
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function daysBetween(aIso, bIso) {
  const ms = Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime());
  return Math.floor(ms / 86400000);
}

function nowIso() {
  return new Date().toISOString();
}

function isStaff(member) {
  return member?.roles?.cache?.has(STAFF_ROLE_ID);
}

function computeTotal(qty) {
  const blocks = qty / 1000;
  return Math.round(blocks * PRICE_PER_1000);
}

// ========= AUTO CLOSE HELPERS =========
function touchActivity(order, reason = "activity") {
  order.lastActivityAt = nowIso();
  order.lastActivityReason = reason;
  orders.set(order.orderId, order);
  saveOrders();
}

function setAutoCloseDeadline(order, minutes = AUTO_CLOSE_MINUTES, reason = "set_deadline") {
  order.autoCloseEnabled = true;
  order.autoClosePaused = false;
  order.autoCloseReason = reason;
  order.autoCloseDeadlineAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  touchActivity(order, `autoclose:${reason}`);
}

function bumpAutoCloseDeadline(order, minutes = AUTO_CLOSE_MINUTES, reason = "bump_deadline") {
  order.autoCloseEnabled = true;
  order.autoClosePaused = false;
  order.autoCloseReason = reason;
  order.autoCloseDeadlineAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  touchActivity(order, `autoclose:${reason}`);
}

function clearAutoCloseDeadline(order, reason = "clear_deadline") {
  order.autoCloseEnabled = false;
  order.autoClosePaused = false;
  order.autoCloseReason = reason;
  order.autoCloseDeadlineAt = null;
  touchActivity(order, `autoclose:${reason}`);
}

// ========= ROBLOX HELPERS =========
async function robloxUsernameToUserId(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Roblox username->id failed: ${r.status} ${t}`);
  }

  const json = await r.json();
  const data = json?.data?.[0];
  if (!data?.id) return null;
  return data.id;
}

async function robloxGetGroupMembershipForUser(groupId, userId) {
  const filter = encodeURIComponent(`user == 'users/${userId}'`);
  const url = `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships?filter=${filter}&pageSize=10`;

  const r = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": ROBLOX_API_KEY },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Roblox membership fetch failed: ${r.status} ${t}`);
  }

  const json = await r.json();
  const memberships =
    json?.groupMemberships ||
    json?.memberships ||
    json?.data ||
    json?.group_memberships ||
    [];

  if (!Array.isArray(memberships) || memberships.length === 0) return null;
  return memberships[0];
}

function extractMembershipJoinTime(membership) {
  const candidates = [
    membership?.createTime,
    membership?.createdTime,
    membership?.create_time,
    membership?.joinedTime,
    membership?.joinTime,
    membership?.startTime,
    membership?.createdAt,
  ].filter(Boolean);

  if (candidates.length === 0) return null;
  const dt = new Date(candidates[0]);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

async function checkRobloxGroupEligibility(username) {
  const clean = String(username || "").trim().replace(/^@/, "");
  if (!clean) return { ok: false, reason: "Username kosong." };

  const userId = await robloxUsernameToUserId(clean);
  if (!userId) return { ok: false, reason: "Username Roblox tidak ditemukan." };

  const membership = await robloxGetGroupMembershipForUser(ROBLOX_GROUP_ID, userId);
  if (!membership) {
    return {
      ok: false,
      reason: "User belum join komunitas Roblox (Group).",
      userId,
      joinTime: null,
      daysInGroup: 0,
      isMember: false,
    };
  }

  const joinTimeIso = extractMembershipJoinTime(membership);
  if (!joinTimeIso) {
    return {
      ok: false,
      reason: "User member, tapi API tidak mengembalikan tanggal join. Tidak bisa validasi 14 hari.",
      userId,
      joinTime: null,
      daysInGroup: null,
      isMember: true,
    };
  }

  const now = nowIso();
  const daysInGroup = daysBetween(now, joinTimeIso);
  const eligible = daysInGroup >= ELIGIBLE_DAYS;

  return {
    ok: eligible,
    reason: eligible
      ? "Eligible."
      : `Belum ${ELIGIBLE_DAYS} hari join komunitas. Baru ${daysInGroup} hari.`,
    userId,
    joinTime: joinTimeIso,
    daysInGroup,
    isMember: true,
  };
}

// ========= AUTO STOCK (GROUP FUNDS) =========
async function robloxGetGroupFunds(groupId) {
  const url = `https://economy.roblox.com/v1/groups/${groupId}/currency`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
      "User-Agent": "OLENG-BEACH-StockBot/1.0",
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Roblox group funds fetch failed: ${r.status} ${t}`);
  }

  const json = await r.json();
  const robux = Number(json?.robux);
  if (!Number.isFinite(robux)) {
    throw new Error("Roblox group funds invalid response (missing robux).");
  }
  return robux;
}

function computeReservedRobux() {
  let reserved = 0;

  for (const o of orders.values()) {
    if (!o || !o.qty) continue;

    const lockingStatuses = new Set([
      "AWAITING_PAYMENT",
      "AWAITING_PROOF",
      "PROOF_SUBMITTED",
    ]);

    if (lockingStatuses.has(o.status)) {
      reserved += Number(o.qty || 0);
    }
  }

  return Math.max(0, Math.floor(reserved));
}

let stockCache = {
  ok: false,
  groupFunds: 0,
  reserved: 0,
  available: 0,
  updatedAt: null,
  error: null,
};

const stockBroadcastState = {
  initialized: false,
  lastObservedAvailable: null,
  lastObservedMode: null, // READY | OUT
};

async function refreshStockCache() {
  const previous = { ...stockCache };

  try {
    const groupFunds = await robloxGetGroupFunds(ROBLOX_GROUP_ID);
    const reserved = computeReservedRobux();
    const available = Math.max(0, Math.floor(groupFunds - reserved));

    stockCache = {
      ok: true,
      groupFunds,
      reserved,
      available,
      updatedAt: nowIso(),
      error: null,
    };
  } catch (e) {
    stockCache = {
      ...stockCache,
      ok: false,
      updatedAt: nowIso(),
      error: String(e?.message || e),
    };
  }

  return {
    previous,
    current: { ...stockCache },
  };
}

function isStockReady() {
  return Number(stockCache?.available || 0) >= 1000;
}

function getStockBroadcastMode(available) {
  return Number(available || 0) >= 1000 ? "READY" : "OUT";
}

// ========= INVOICE (PDF) =========
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function createInvoicePdf(order, staffUser) {
  return new Promise((resolve, reject) => {
    try {
      const outDir = path.resolve("./invoices");
      ensureDir(outDir);

      const fileName = `INV-${order.orderId}-${Date.now()}.pdf`;
      const filePath = path.join(outDir, fileName);

      const doc = new PDFDocument({ size: "A4", margin: 48 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(20).text(`${STORE_NAME}`, { align: "left" });
      doc.moveDown(0.2);
      doc.fontSize(10).text("Invoice / Bukti Pembelian", { align: "left" });
      doc.moveDown(1);

      const createdAt = order.doneAt || nowIso();
      doc.fontSize(11);
      doc.text(`Invoice No : INV-${order.orderId}`);
      doc.text(`Order ID   : ${order.orderId}`);
      doc.text(`Tanggal    : ${fmtDateID(createdAt)} WIB`);
      doc.text(`Customer   : <@${order.userId}>`);
      doc.text(`Roblox User : ${order.robloxUsername || "-"}`);
      doc.text(`Metode Bayar: Bank Transfer (SeaBank)`);
      doc.text(`Diproses oleh: ${staffUser?.tag || staffUser?.username || staffUser?.id || "-"}`);
      doc.moveDown(1);

      doc.moveTo(48, doc.y).lineTo(548, doc.y).stroke();
      doc.moveDown(1);

      doc.fontSize(12).text("Detail Pembelian", { underline: true });
      doc.moveDown(0.6);

      const itemName = "Robux via Community Payout";
      const qty = Number(order.qty || 0);
      const total = Number(order.total || 0);

      doc.fontSize(11);
      doc.text(`Item   : ${itemName}`);
      doc.text(`Qty    : ${fmtIDR(qty)} Robux`);
      doc.text(`Harga  : Rp ${fmtIDR(total)}`);
      doc.moveDown(1);

      doc.moveTo(48, doc.y).lineTo(548, doc.y).stroke();
      doc.moveDown(0.8);

      doc.fontSize(10).text(
        [
          "Catatan:",
          "• Simpan invoice ini sebagai bukti pembelian.",
          "• Jika ada kendala, hubungi staff/owner dan sertakan Order ID.",
        ].join(os.EOL)
      );

      doc.moveDown(1.2);
      doc.fontSize(9).text(STORE_FOOTER, { align: "center" });

      doc.end();

      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

function buildInvoiceEmbed(order) {
  const dt = order.doneAt || nowIso();
  return new EmbedBuilder()
    .setTitle(`🧾 INVOICE — ${order.orderId}`)
    .setDescription(
      [
        `**Invoice No:** INV-${order.orderId}`,
        `**Tanggal:** ${fmtDateID(dt)} WIB`,
        "",
        `👤 **Discord:** <@${order.userId}>`,
        `🎮 **Roblox:** \`${order.robloxUsername}\``,
        "",
        `💎 **Robux:** ${fmtIDR(order.qty)}`,
        `💰 **Total:** Rp ${fmtIDR(order.total)}`,
        "",
        `✅ **Status:** DONE`,
      ].join("\n")
    )
    .setFooter({ text: STORE_FOOTER });
}

// ========= DISCORD UI BUILDERS =========
function buildPanelEmbed() {
  const stockLine = stockCache.ok
    ? `**STATUS STOK:** ${isStockReady() ? "READY" : "HABIS"}`
    : `**STATUS STOK:** (gagal fetch)`;

  const stockWarn = "";

  const stockMeta = stockCache.ok
    ? `\n_Updated: ${fmtDateID(stockCache.updatedAt)} WIB_`
    : `\n_Updated: ${fmtDateID(stockCache.updatedAt)} WIB | Error: ${stockCache.error}_`;

  return new EmbedBuilder()
    .setTitle("💸ORDER ROBUX — VIA COMMUNITY PAYOUT")
    .setDescription(
      [
        stockLine + stockWarn + stockMeta,
        "",
        "**Syarat sebelum order**",
        `• Wajib join komunitas Roblox minimal **${ELIGIBLE_DAYS} hari**`,
        "• Link komunitas: https://www.roblox.com/share/g/819348691",
        "",
        "💰 **PRICE LIST ROBUX**",
        "💎 1.000 Robux = Rp 100.000",
        "💎 2.000 Robux = Rp 200.000",
        "💎 3.000 Robux = Rp 300.000",
        "💎 4.000 Robux = Rp 400.000",
        "💎 5.000 Robux = Rp 500.000",
        "➡️ dan seterusnya (kelipatan 1.000)",
        "",
        "**Cara order (step by step)**",
        "1) Klik tombol **ORDER ROBUX** di bawah",
        "2) Isi **Username Roblox** & **Jumlah**",
        "3) Bot cek join komunitas Roblox",
        "4) Ticket dibuat otomatis",
        "5) Staff kirim intruksi **Pembayaran** → customer pilih **Bank Transfer**",
        "6) Customer transfer lalu kirim **bukti transfer** di ticket",
        "",
        "⚠️ **PENTING — JANGAN TRANSFER sebelum instruksi pembayaran muncul!**",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH — Order Robux System" });
}

function buildStockStatusButton() {
  const ready = isStockReady();
  const label = ready ? "📦 STOK: READY" : "⛔ STOK: HABIS";

  return new ButtonBuilder()
    .setCustomId("ob_stock_info")
    .setLabel(label)
    .setStyle(ready ? ButtonStyle.Primary : ButtonStyle.Danger)
    .setDisabled(true);
}

function buildPanelComponents() {
  const ready = isStockReady();
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ob_order_open_modal")
        .setLabel("💸ORDER ROBUX")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!ready),
      buildStockStatusButton()
    ),
  ];
}

async function refreshPanelMessage(client) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(PANEL_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const embed = buildPanelEmbed();
    const components = buildPanelComponents();

    const msgs = await channel.messages.fetch({ limit: 20 });
    const existing = msgs.find(
      (m) => m.author.id === client.user.id && m.embeds?.[0]?.title?.includes("ORDER ROBUX")
    );

    if (existing) {
      await existing.edit({ embeds: [embed], components });
    } else {
      await channel.send({ embeds: [embed], components });
    }
  } catch (e) {
    console.error("refreshPanelMessage error:", e);
  }
}

function buildOrderModal() {
  const modal = new ModalBuilder()
    .setCustomId("ob_order_modal_submit")
    .setTitle("Order OLENG BEACH");

  const username = new TextInputBuilder()
    .setCustomId("roblox_username")
    .setLabel("Username Roblox (tanpa @, bukan Display Name)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const qty = new TextInputBuilder()
    .setCustomId("qty")
    .setLabel("Jumlah (minimal 1000, kelipatan 1000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Catatan tambahan (opsional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(username),
    new ActionRowBuilder().addComponents(qty),
    new ActionRowBuilder().addComponents(note)
  );

  return modal;
}

function buildCustomerStatusEmbed(order) {
  const days = Number.isFinite(order.robloxDaysInGroup) ? order.robloxDaysInGroup : 0;
  const joinLine = order.robloxJoinTime ? fmtDateID(order.robloxJoinTime) : "-";

  const eligibleLine = order.robloxEligible
    ? `✅ Eligible — **${days}/${ELIGIBLE_DAYS} hari**`
    : `❌ Tidak eligible — **${days}/${ELIGIBLE_DAYS} hari**`;

  const desc = order.robloxEligible
    ? [
        `👤 **Username Roblox:** \`${order.robloxUsername}\``,
        "",
        `📊 **Status Join Community:** ${eligibleLine}`,
        `📅 **Tanggal Join:** ${joinLine}`,
        "",
        `💎 **Total Robux:** ${fmtIDR(order.qty)}`,
        `💰 **Total Harga:** Rp ${fmtIDR(order.total)}`,
        "",
        "Klik **Bank Transfer** untuk melihat instruksi pembayaran.",
        "Setelah transfer, kirim **bukti pembayaran (file apapun / gambar / dokumen / forward)** di ticket ini.",
      ].join("\n")
    : [
        `👤 **Username Roblox:** \`${order.robloxUsername}\``,
        "",
        `📊 **Status Join Community:** ${eligibleLine}`,
        `📅 **Tanggal Join:** ${joinLine}`,
        "",
        `⚠️ Alasan: ${order.ineligibleReason || "Belum memenuhi syarat."}`,
        "",
        `⏳ Ticket ini akan otomatis ditutup setelah **${AUTO_CLOSE_MINUTES} menit** meskipun ada chat atau file yang dikirim.`,
        "Silakan join komunitas sampai memenuhi syarat, lalu order ulang.",
      ].join("\n");

  return new EmbedBuilder()
    .setTitle(`OLENG BEACH — Ticket ${order.orderId}`)
    .setDescription(desc)
    .setColor(order.robloxEligible ? 0x2ecc71 : 0xe74c3c)
    .setFooter({ text: "OLENG BEACH — Order System" });
}

function buildCustomerButtonsEligible(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_bank:${orderId}`)
        .setLabel("🏦 Bank Transfer")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`ob_cancel_user:${orderId}`)
        .setLabel("❌ Close Order")
        .setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_copy_username:${orderId}`)
        .setLabel("📋 Copy Username")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildButtonsAfterDone(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_close_ticket:${orderId}`)
        .setLabel("🔒 Close Ticket")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildCustomerButtonsIneligible(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_close_ineligible:${orderId}`)
        .setLabel("🔒 Close Ticket")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildSeaBankInstructions(order) {
  return new EmbedBuilder()
    .setTitle("Instruksi Pembayaran — Bank Transfer")
    .setDescription(
      [
        `**Order:** ${order.orderId}`,
        `**Total Bayar:** Rp ${fmtIDR(order.total)}`,
        "",
        `**Bank SeaBank:** \`${SEABANK_ACCOUNT}\``,
        `**A/N:** ${SEABANK_NAME}`,
        "",
        "✅ Setelah transfer, **kirim bukti transfer (file apapun / gambar / dokumen / forward)** di chat ticket ini.",
        "⚠️ Pastikan nominal & rekening benar.",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH" });
}

function buildPaymentButtons(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_copy_bank:${orderId}`)
        .setLabel("📋 Copy No. Rekening")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// ========= AUTO BROADCAST =========
function getPanelUrl() {
  return `https://discord.com/channels/${GUILD_ID}/${PANEL_CHANNEL_ID}`;
}

function buildStockReadyBroadcastEmbed() {
  return new EmbedBuilder()
    .setColor(0x00ff95)
    .setTitle("💚✨ STOCK ROBUX READY SEKARANG ✨💚")
    .setDescription(
      [
        "🚀 **UPDATE STOK MASUK!**",
        "",
        "🔥 **Bisa langsung order sekarang**",
        "⚡ **Fast response**",
        "🎯 **Via Community Payout**",
        `✅ **Wajib join komunitas minimal ${ELIGIBLE_DAYS} hari**`,
        "",
        `🛒 **Langsung order ke <#${PANEL_CHANNEL_ID}>**`,
        "",
        "❗ **Buruan order sebelum stok berubah lagi!**",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH — Realtime Stock Update" })
    .setTimestamp();
}

function buildStockOutBroadcastEmbed() {
  return new EmbedBuilder()
    .setColor(0xff2e63)
    .setTitle("🚨⛔ STOCK ROBUX HABIS ⛔🚨")
    .setDescription(
      [
        "😵 **Untuk saat ini stok Robux sedang habis.**",
        "",
        "📌 Tunggu update stok berikutnya di channel ini.",
        "🔔 Kalau stok masuk lagi, bot akan langsung kasih info terbaru.",
        "",
        `🛒 Nanti kalau sudah ready lagi, langsung order di <#${PANEL_CHANNEL_ID}> ya.`,
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH — Realtime Stock Update" })
    .setTimestamp();
}

function buildStockBroadcastButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("🛒 ORDER ROBUX SEKARANG")
        .setStyle(ButtonStyle.Link)
        .setURL(getPanelUrl())
    ),
  ];
}

function buildTestimoniEmbed(order, customerUser, staffUser) {
  const tanggalOrder = fmtDateID(order.doneAt || order.createdAt || nowIso());
  const customerAvatar =
    customerUser?.displayAvatarURL?.({ extension: "png", size: 512 }) || null;

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("🌟 TESTIMONI PEMBELIAN ROBUX 🌟")
    .setDescription(
      [
        "```yaml",
        "Status    : BERHASIL DIPROSES",
        "Layanan   : Robux via Community Payout",
        "```",
        "",
        "✨ **Pesanan berhasil diproses dengan sukses!**",
        "",
        `👤 **Customer Discord** : ${customerUser ? `<@${customerUser.id}>` : `<@${order.userId}>`}`,
        `🎮 **Username Roblox** : \`${order.robloxUsername}\``,
        `💎 **Jumlah Robux**    : **${fmtIDR(order.qty)} Robux**`,
        `💰 **Total Bayar**     : **Rp ${fmtIDR(order.total)}**`,
        `🧾 **Order ID**        : \`${order.orderId}\``,
        `📅 **Tanggal Order**   : **${tanggalOrder} WIB**`,
        `🛠️ **Diproses Oleh**   : ${staffUser ? `<@${staffUser.id}>` : "-"}`,
        "",
        `💚 Terima kasih sudah order di **${STORE_NAME}**`,
        "🚀 Ditunggu order berikutnya yaa!",
      ].join("\n")
    )
    .setThumbnail(customerAvatar)
    .setFooter({ text: "OLENG BEACH — Testimoni Order" })
    .setTimestamp();
}

async function sendTestimoniMessage(client, order, staffUser) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(TESTIMONI_CHANNEL_ID);

    if (!channel) return;
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      console.error("TESTIMONI_CHANNEL_ID must be a text or announcement channel.");
      return;
    }

    const customerUser = await client.users.fetch(order.userId).catch(() => null);

    await channel.send({
      content: "✨ **Testimoni order baru berhasil diproses!** ✨",
      embeds: [buildTestimoniEmbed(order, customerUser, staffUser)],
    });
  } catch (e) {
    console.error("sendTestimoniMessage error:", e);
  }
}

async function sendAutoStockBroadcast(client, mode) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(UPDATE_STOCK_CHANNEL_ID);

    if (!channel) return;
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      console.error("UPDATE_STOCK_CHANNEL_ID must be a text or announcement channel.");
      return;
    }

    const payload =
      mode === "OUT"
        ? {
            content: "🚨 @everyone",
            embeds: [buildStockOutBroadcastEmbed()],
            components: buildStockBroadcastButtons(),
            allowedMentions: { parse: ["everyone"] },
          }
        : {
            content: "🚨 @everyone",
            embeds: [buildStockReadyBroadcastEmbed()],
            components: buildStockBroadcastButtons(),
            allowedMentions: { parse: ["everyone"] },
          };

    await channel.send(payload);
  } catch (e) {
    console.error("sendAutoStockBroadcast error:", e);
  }
}

async function maybeBroadcastStockChange(client, refreshResult, options = {}) {
  const { suppressBroadcast = false } = options;
  const current = refreshResult?.current;

  if (!current?.ok) return;

  const currAvailable = Number(current.available || 0);
  const currMode = getStockBroadcastMode(currAvailable);

  if (!stockBroadcastState.initialized || suppressBroadcast) {
    stockBroadcastState.initialized = true;
    stockBroadcastState.lastObservedAvailable = currAvailable;
    stockBroadcastState.lastObservedMode = currMode;
    return;
  }

  const prevMode = stockBroadcastState.lastObservedMode;

  let shouldBroadcast = false;
  let broadcastMode = null;

  if (prevMode !== currMode) {
    shouldBroadcast = true;
    broadcastMode = currMode;
  }

  if (shouldBroadcast && broadcastMode) {
    await sendAutoStockBroadcast(client, broadcastMode);
  }

  stockBroadcastState.lastObservedAvailable = currAvailable;
  stockBroadcastState.lastObservedMode = currMode;
}

async function syncStockAndPanel(client, options = {}) {
  const refreshResult = await refreshStockCache();
  await maybeBroadcastStockChange(client, refreshResult, options);
  await refreshPanelMessage(client);
  return refreshResult;
}

// ========= CHANNEL CLOSE =========
async function deleteTicketChannel(channel, order, reasonText, finalStatus = null) {
  try {
    const terminal = new Set(["DONE", "CANCELLED", "INELIGIBLE", "EXPIRED", "CLOSED"]);
    if (finalStatus) {
      order.status = finalStatus;
    } else if (!terminal.has(order.status)) {
      order.status = "CLOSED";
    }

    order.closedAt = nowIso();
    order.autoCloseEnabled = false;
    order.autoClosePaused = false;
    order.autoCloseDeadlineAt = null;

    orders.set(order.orderId, order);
    saveOrders();

    if (reasonText) {
      await channel.send(reasonText).catch(() => {});
    }

    setTimeout(async () => {
      try {
        await channel.delete("Ticket closed (deleted).");
      } catch (e) {
        console.error("Failed to delete channel:", e);
        try {
          await channel.permissionOverwrites.edit(order.userId, {
            SendMessages: false,
          }).catch(() => {});
          await channel
            .send("⚠️ Bot gagal menghapus channel (permission). Ticket dikunci sebagai fallback.")
            .catch(() => {});
        } catch {}
      }
    }, 3000);
  } catch (e) {
    console.error("deleteTicketChannel error:", e);
  }
}

/**
 * Status auto close:
 * - AWAITING_PAYMENT  -> EXPIRED
 * - AWAITING_PROOF    -> EXPIRED
 * - DONE              -> CLOSED
 * - INELIGIBLE        -> INELIGIBLE (channel ditutup otomatis)
 * - PROOF_SUBMITTED   -> tidak auto close
 */
async function runAutoCloseSweep(client) {
  const now = Date.now();

  for (const order of orders.values()) {
    try {
      if (!order?.channelId) continue;
      if (!order.autoCloseEnabled) continue;
      if (!order.autoCloseDeadlineAt) continue;

      if (["CLOSED", "CANCELLED", "EXPIRED", "PROOF_SUBMITTED"].includes(order.status)) {
        continue;
      }

      const deadline = new Date(order.autoCloseDeadlineAt).getTime();
      if (!Number.isFinite(deadline)) continue;
      if (now < deadline) continue;

      const guild = await client.guilds.fetch(order.guildId).catch(() => null);
      if (!guild) continue;

      const ch = await guild.channels.fetch(order.channelId).catch(() => null);
      if (!ch) {
        order.autoCloseEnabled = false;
        order.autoCloseDeadlineAt = null;
        orders.set(order.orderId, order);
        saveOrders();
        continue;
      }

      if (order.status === "AWAITING_PAYMENT" || order.status === "AWAITING_PROOF") {
        order.status = "EXPIRED";
        order.expiredAt = nowIso();
        order.autoCloseEnabled = false;
        order.autoCloseDeadlineAt = null;

        orders.set(order.orderId, order);
        saveOrders();

        await syncStockAndPanel(client).catch(() => {});

        const msg =
          `⌛ Ticket expired otomatis karena tidak ada aktivitas selama ${AUTO_CLOSE_MINUTES} menit. ` +
          `Order dibatalkan, stok dikembalikan. Ticket akan dihapus...`;

        await deleteTicketChannel(ch, order, msg, "EXPIRED");
        continue;
      }

      if (order.status === "INELIGIBLE") {
        await deleteTicketChannel(
          ch,
          order,
          `🔒 Ticket ineligible ditutup otomatis setelah ${AUTO_CLOSE_MINUTES} menit. ` +
            `Chat atau file yang dikirim tidak memperpanjang waktu ticket ini. Ticket akan dihapus...`,
          "INELIGIBLE"
        );
        continue;
      }

      if (order.status === "DONE") {
        await deleteTicketChannel(
          ch,
          order,
          `🔒 Ticket ditutup otomatis setelah order selesai karena tidak ada aktivitas selama ${AUTO_CLOSE_MINUTES} menit. Ticket akan dihapus...`,
          "CLOSED"
        );

        await syncStockAndPanel(client).catch(() => {});
        continue;
      }

      await deleteTicketChannel(
        ch,
        order,
        `🔒 Ticket ditutup otomatis (inactivity ${AUTO_CLOSE_MINUTES} menit). Ticket akan dihapus...`,
        "CLOSED"
      );

      await syncStockAndPanel(client).catch(() => {});
    } catch (e) {
      console.error("Auto-close sweep error:", e);
    }
  }
}

// ========= DISCORD CLIENT =========
loadOrders();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  setInterval(() => runAutoCloseSweep(client), 60 * 1000).unref();

  const guild = await client.guilds.fetch(GUILD_ID);

  await guild.commands.set([
    new SlashCommandBuilder()
      .setName("proses")
      .setDescription("Staff: proses order")
      .addStringOption((option) =>
        option
          .setName("aksi")
          .setDescription("Aksi proses")
          .setRequired(true)
          .addChoices({ name: "selesai", value: "SELESAI" })
      )
      .addStringOption((option) =>
        option
          .setName("order")
          .setDescription("Order ID (contoh: T-12345). Kosongkan jika jalankan di dalam ticket.")
          .setRequired(false)
      )
      .toJSON(),
  ]);

  console.log("Slash command /proses registered.");

  await syncStockAndPanel(client, { suppressBroadcast: true });

  setInterval(async () => {
    try {
      await syncStockAndPanel(client);
    } catch (e) {
      console.error("stock/panel interval error:", e);
    }
  }, STOCK_REFRESH_MINUTES * 60 * 1000).unref();
});

// ========= MESSAGE TRACKING =========
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    const order = Array.from(orders.values()).find((o) => o.channelId === msg.channelId);
    if (!order) return;

    const isCustomer = msg.author.id === order.userId;

    touchActivity(order, isCustomer ? "customer_message" : "staff_or_other_message");

    if (order.status === "INELIGIBLE") {
      return;
    }

    if (order.status === "DONE") {
      bumpAutoCloseDeadline(order, AUTO_CLOSE_MINUTES, "message_after_done");
      orders.set(order.orderId, order);
      saveOrders();
      return;
    }

    if (order.status === "AWAITING_PAYMENT" || order.status === "AWAITING_PROOF") {
      bumpAutoCloseDeadline(order, AUTO_CLOSE_MINUTES, "message_before_done");
      orders.set(order.orderId, order);
      saveOrders();
    }

    if (order.status === "AWAITING_PROOF" && isCustomer) {
      const hasAnyAttachment = msg.attachments && msg.attachments.size > 0;
      if (!hasAnyAttachment) return;

      order.status = "PROOF_SUBMITTED";
      order.proofSubmittedAt = nowIso();
      order.autoCloseEnabled = false;
      order.autoClosePaused = false;
      order.autoCloseDeadlineAt = null;

      touchActivity(order, "proof_any_file_submitted");

      orders.set(order.orderId, order);
      saveOrders();

      await syncStockAndPanel(client).catch(() => {});

      await msg.channel
        .send(
          `✅ Bukti pembayaran diterima dari <@${order.userId}>.\n` +
            `📎 Tipe bukti: **file/forward**\n` +
            `👮‍♂️ Staff/Owner akan proses Robux kamu, mohon bersedia menunggu...`
        )
        .catch(() => {});
    }
  } catch (e) {
    console.error("messageCreate error:", e);
  }
});

client.on("interactionCreate", async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === "proses") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      if (!isStaff(member)) {
        return i.reply({ content: "Khusus staff/owner.", ephemeral: true });
      }

      const aksi = i.options.getString("aksi");
      const orderArg = i.options.getString("order");
      const channelId = i.channelId;

      if (aksi !== "SELESAI") {
        return i.reply({ content: "Aksi tidak valid.", ephemeral: true });
      }

      let order = null;
      if (orderArg) {
        order = orders.get(orderArg);
        if (!order) {
          return i.reply({ content: "Order ID tidak ditemukan.", ephemeral: true });
        }
      } else {
        order = Array.from(orders.values()).find((o) => o.channelId === channelId);
        if (!order) {
          return i.reply({
            content: "Command ini harus dipakai di channel ticket, atau isi option order.",
            ephemeral: true,
          });
        }
      }

      if (order.channelId !== channelId) {
        return i.reply({
          content: "Order itu bukan untuk channel ini. Jalankan di channel ticket yang benar.",
          ephemeral: true,
        });
      }

      if (order.status !== "PROOF_SUBMITTED" && order.status !== "AWAITING_PROOF") {
        return i.reply({ content: "Belum ada bukti pembayaran (file/forward).", ephemeral: true });
      }

      order.status = "DONE";
      order.doneAt = nowIso();
      setAutoCloseDeadline(order, AUTO_CLOSE_MINUTES, "staff_done_command");

      orders.set(order.orderId, order);
      saveOrders();

      await syncStockAndPanel(client).catch(() => {});

      const now = new Date();
      const tanggal = now.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
      const jam = now.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });

      await i.reply({ content: `✅ Proses selesai untuk **${order.orderId}**.`, ephemeral: true });

      await i.channel
        .send({
          content:
            `🎉 **ORDER BERHASIL DIKIRIM!** 🎉\n\n` +
            `👤 Username Roblox: \`${order.robloxUsername}\`\n` +
            `💎 Total Robux: **${fmtIDR(order.qty)}**\n` +
            `💰 Total Bayar: **Rp ${fmtIDR(order.total)}**\n` +
            `📅 Tanggal: **${tanggal}**\n` +
            `⏰ Jam: **${jam} WIB**\n\n` +
            `Silakan cek kembali Robux kamu.\n` +
            `Jika ada kendala, silakan hubungi staff/owner.\n\n` +
            `⏳ Ticket akan ditutup otomatis jika tidak ada aktivitas selama **${AUTO_CLOSE_MINUTES} menit**.`,
          components: buildButtonsAfterDone(order.orderId),
        })
        .catch(() => {});

      await sendTestimoniMessage(client, order, i.user).catch(() => {});

      let pdfPath = null;
      try {
        pdfPath = await createInvoicePdf(order, i.user);
        const fileName = path.basename(pdfPath);
        const invoiceEmbed = buildInvoiceEmbed(order);

        try {
          const customerUser = await client.users.fetch(order.userId);
          const dmInvoiceFile = new AttachmentBuilder(pdfPath, { name: fileName });

          await customerUser.send({
            content:
              `Halo! Berikut invoice untuk order kamu di **${STORE_NAME}**.\n` +
              `Order ID: **${order.orderId}**\n` +
              `Diproses oleh: **${i.user.tag}**`,
            embeds: [invoiceEmbed],
            files: [dmInvoiceFile],
          });
        } catch (eDm) {
          console.error("Invoice DM send error:", eDm?.stack || eDm);
        }

        const ticketInvoiceFile = new AttachmentBuilder(pdfPath, { name: fileName });

        await i.channel.send({
          content: `🧾 Invoice untuk order **${order.orderId}** (silakan download PDF di bawah).`,
          embeds: [invoiceEmbed],
          files: [ticketInvoiceFile],
        });
      } catch (e) {
        console.error("Invoice generate/send error:", e?.stack || e);
        await i.channel
          .send(
            `⚠️ Proses selesai, tapi gagal membuat/mengirim invoice PDF.\n**Error:** \`${String(
              e?.message || e
            )}\``
          )
          .catch(() => {});
      } finally {
        if (pdfPath) fs.unlink(pdfPath, () => {});
      }

      return;
    }

    if (i.isButton() && i.customId === "ob_order_open_modal") {
      await syncStockAndPanel(client).catch(() => {});

      if (!isStockReady()) {
        return i.reply({
          content: `⛔ Stock HABIS.\nStatus stok saat ini: **HABIS**`,
          ephemeral: true,
        });
      }
      return i.showModal(buildOrderModal());
    }

    if (i.isModalSubmit() && i.customId === "ob_order_modal_submit") {
      await i.deferReply({ ephemeral: true });

      return withOrderCreationLock(async () => {
        const robloxUsername = i.fields
          .getTextInputValue("roblox_username")
          ?.trim()
          ?.replace(/^@/, "");
        const qtyRaw = i.fields.getTextInputValue("qty")?.trim();
        const note = i.fields.getTextInputValue("note")?.trim();

        const qty = Number(String(qtyRaw || "").replace(/[^\d]/g, ""));
        if (!Number.isFinite(qty) || qty < 1000) {
          return i.editReply("Jumlah minimal 1000.");
        }
        if (qty % 1000 !== 0) {
          return i.editReply("Jumlah harus kelipatan 1000 (contoh: 1000 / 2000 / 3000).");
        }

        await syncStockAndPanel(client).catch(() => {});

        if (!isStockReady()) {
          return i.editReply(`⛔ Stock HABIS.\nStatus stok saat ini: **HABIS**`);
        }

        if (qty > stockCache.available) {
          return i.editReply(
            `❌ Order gagal. Jumlah Robux yang kamu input **lebih besar** dari stok yang bisa diproses saat ini.\n` +
              `Silakan coba jumlah yang lebih kecil atau tunggu update stok berikutnya.`
          );
        }

        let eligibility;
        try {
          eligibility = await checkRobloxGroupEligibility(robloxUsername);
        } catch (e) {
          console.error("Roblox check error:", e);
          return i.editReply("Gagal cek komunitas Roblox (API). Coba lagi beberapa saat.");
        }

        const orderId = newOrderId();
        const total = computeTotal(qty);

        const guild = await client.guilds.fetch(GUILD_ID);
        const user = i.user;

        let ticket;
        try {
          const ticketName = `oleng-${orderId}`.toLowerCase();
          ticket = await guild.channels.create({
            name: ticketName,
            type: ChannelType.GuildText,
            parent: TICKET_CATEGORY_ID,
            topic: `OLENG BEACH | ${orderId} | User: ${user.id} | Roblox: ${robloxUsername}`,
            permissionOverwrites: [
              { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
              {
                id: client.user.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                  PermissionsBitField.Flags.ManageChannels,
                  PermissionsBitField.Flags.ManageMessages,
                  PermissionsBitField.Flags.AttachFiles,
                  PermissionsBitField.Flags.EmbedLinks,
                ],
              },
              {
                id: user.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                  PermissionsBitField.Flags.AttachFiles,
                ],
              },
              {
                id: STAFF_ROLE_ID,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                  PermissionsBitField.Flags.ManageMessages,
                ],
              },
            ],
          });
        } catch (e) {
          console.error("Ticket create error:", e);
          return i.editReply(
            "Gagal membuat ticket. Cek permission bot di **Category Ticket** (Manage Channels, View Channel, Send Messages)."
          );
        }

        const order = {
          orderId,
          guildId: GUILD_ID,
          channelId: ticket.id,
          userId: user.id,

          robloxUsername,
          robloxUserId: eligibility.userId ?? null,
          robloxJoinTime: eligibility.joinTime ?? null,
          robloxDaysInGroup: eligibility.daysInGroup ?? 0,
          robloxEligible: Boolean(eligibility.ok),
          ineligibleReason: eligibility.ok ? null : eligibility.reason,

          qty,
          total,
          note: note || "",

          status: eligibility.ok ? "AWAITING_PAYMENT" : "INELIGIBLE",
          paymentMethod: "SEABANK",
          createdAt: nowIso(),
          lastActivityAt: nowIso(),

          autoCloseEnabled: true,
          autoClosePaused: false,
          autoCloseDeadlineAt: new Date(Date.now() + AUTO_CLOSE_MINUTES * 60 * 1000).toISOString(),
        };

        orders.set(orderId, order);
        saveOrders();

        await syncStockAndPanel(client).catch(() => {});

        const statusEmbed = buildCustomerStatusEmbed(order);

        if (order.robloxEligible) {
          await ticket
            .send({
              content: `Halo <@${user.id}> 👋\nBerikut detail order kamu. Silakan lanjut pembayaran via tombol di bawah.`,
              embeds: [statusEmbed],
              components: buildCustomerButtonsEligible(orderId),
            })
            .catch(() => {});

          if (order.note) {
            await ticket.send({ content: `📝 Catatan: ${order.note}` }).catch(() => {});
          }
        } else {
          await ticket
            .send({
              content:
                `Halo <@${user.id}> 👋\nKamu **belum memenuhi syarat** untuk order.\n` +
                `⏳ Ticket ini akan auto close dalam **${AUTO_CLOSE_MINUTES} menit** walaupun ada chat atau file yang dikirim.`,
              embeds: [statusEmbed],
              components: buildCustomerButtonsIneligible(orderId),
            })
            .catch(() => {});
        }

        return i.editReply(`✅ Ticket dibuat: <#${ticket.id}>`);
      });
    }

    if (!i.isButton()) return;
    if (!i.guild) return;

    const parts = i.customId.split(":");
    const key = parts[0];
    const orderId = parts[1] || parts[2];
    const order = orderId ? orders.get(orderId) : null;

    const needsOrder = [
      "ob_bank",
      "ob_cancel_user",
      "ob_close_ineligible",
      "ob_copy_username",
      "ob_close_ticket",
      "ob_copy_bank",
    ];

    if (needsOrder.includes(key)) {
      if (!order) return i.reply({ content: "Order tidak ditemukan.", ephemeral: true });
      if (i.channelId !== order.channelId) {
        return i.reply({ content: "Tombol ini hanya valid di ticket ini.", ephemeral: true });
      }
    }

    if (key === "ob_copy_username") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) {
        return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });
      }

      return i.reply({
        content: `📋 Copy username berikut:\n\`\`\`\n${order.robloxUsername}\n\`\`\``,
        ephemeral: true,
      });
    }

    if (key === "ob_copy_bank") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) {
        return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });
      }

      return i.reply({
        content: `🏦 Copy nomor rekening berikut:\n\`\`\`\n${SEABANK_ACCOUNT}\n\`\`\``,
        ephemeral: true,
      });
    }

    if (key === "ob_bank") {
      if (!order.robloxEligible) {
        return i.reply({ content: "Order ini tidak eligible.", ephemeral: true });
      }

      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) {
        return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });
      }

      order.status = "AWAITING_PROOF";
      setAutoCloseDeadline(order, AUTO_CLOSE_MINUTES, "bank_transfer_clicked");
      orders.set(order.orderId, order);
      saveOrders();

      await syncStockAndPanel(client).catch(() => {});

      await i.reply({
        embeds: [buildSeaBankInstructions(order)],
        components: buildPaymentButtons(order.orderId),
      });

      await i.channel
        .send(
          `📌 Setelah transfer, kirim **bukti pembayaran (file apapun / gambar / dokumen / forward)** di sini. ` +
            `Jika dalam **${AUTO_CLOSE_MINUTES} menit** tidak kirim bukti pembayaran, order akan di close (expired) otomatis.`
        )
        .catch(() => {});
      return;
    }

    if (key === "ob_cancel_user") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) {
        return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });
      }

      if (order.status === "DONE") {
        return i.reply({
          content: "Order sudah **DONE**. Tidak bisa cancel. Silakan gunakan tombol **Close Ticket**.",
          ephemeral: true,
        });
      }

      order.status = "CANCELLED";
      order.cancelledAt = nowIso();
      order.autoCloseEnabled = false;
      order.autoClosePaused = false;
      order.autoCloseDeadlineAt = null;

      orders.set(order.orderId, order);
      saveOrders();

      await syncStockAndPanel(client).catch(() => {});

      await i.reply({ content: "❌ Order ditutup. Ticket akan dihapus dalam 3 detik...", ephemeral: true });
      await deleteTicketChannel(i.channel, order, "❌ Order ditutup oleh user. Ticket akan dihapus...", "CANCELLED");
      return;
    }

    if (key === "ob_close_ticket") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) {
        return i.reply({ content: "Kamu tidak punya akses untuk ticket ini.", ephemeral: true });
      }

      if (order.status !== "DONE" && !isStaff(member)) {
        return i.reply({
          content: "Ticket ini belum DONE. Jika mau batal, gunakan tombol **Close Order**.",
          ephemeral: true,
        });
      }

      await i.reply({ content: "🔒 Ticket akan dihapus dalam 3 detik...", ephemeral: true });
      await deleteTicketChannel(i.channel, order, "🔒 Ticket ditutup. Ticket akan dihapus...", "CLOSED");

      await syncStockAndPanel(client).catch(() => {});
      return;
    }

    if (key === "ob_close_ineligible") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) {
        return i.reply({ content: "Kamu tidak punya akses untuk ticket ini.", ephemeral: true });
      }

      order.status = "CLOSED";
      order.closedAt = nowIso();
      order.autoCloseEnabled = false;
      order.autoClosePaused = false;
      order.autoCloseDeadlineAt = null;

      orders.set(order.orderId, order);
      saveOrders();

      await syncStockAndPanel(client).catch(() => {});

      await i.reply({ content: "🔒 Ticket akan dihapus dalam 3 detik...", ephemeral: true });
      await deleteTicketChannel(i.channel, order, "🔒 Ticket ditutup (ineligible). Ticket akan dihapus...", "CLOSED");
      return;
    }
  } catch (e) {
    console.error("interaction error:", e?.stack || e);
    if (i.deferred || i.replied) {
      await i.followUp({ content: "Terjadi error. Coba lagi.", ephemeral: true }).catch(() => {});
    } else {
      await i.reply({ content: "Terjadi error. Coba lagi.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);