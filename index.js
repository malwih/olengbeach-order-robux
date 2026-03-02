import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
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
} from "discord.js";

// ========= CONFIG =========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_GROUP_ID = 819348691; // from https://www.roblox.com/share/g/819348691

const SEABANK_ACCOUNT = process.env.SEABANK_ACCOUNT || "ISI_REKENING";
const SEABANK_NAME = process.env.SEABANK_NAME || "ISI_NAMA_REKENING";

const ELIGIBLE_DAYS = Number(process.env.ELIGIBLE_DAYS || 14);
const PRICE_PER_1000 = Number(process.env.PRICE_PER_1000 || 100000);

const AUTO_CLOSE_MINUTES = Number(process.env.AUTO_CLOSE_MINUTES || 30);

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!PANEL_CHANNEL_ID) throw new Error("Missing PANEL_CHANNEL_ID");
if (!TICKET_CATEGORY_ID) throw new Error("Missing TICKET_CATEGORY_ID");
if (!STAFF_ROLE_ID) throw new Error("Missing STAFF_ROLE_ID");
if (!ROBLOX_API_KEY) throw new Error("Missing ROBLOX_API_KEY");

// ========= STORAGE =========
const DATA_FILE = path.resolve("./orders.json");
/** @type {Map<string, any>} */
const orders = new Map();

function loadOrders() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const o of arr) orders.set(o.orderId, o);
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

function newOrderId() {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `T-${n}`;
}

function fmtIDR(n) {
  return new Intl.NumberFormat("id-ID").format(n);
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

// ========= STOCK STORAGE =========
const STOCK_FILE = path.resolve("./stock.json");
let stockState = {
  status: "READY", // READY | HABIS
  updatedAt: null,
  updatedBy: null,
};

function loadStock() {
  try {
    if (!fs.existsSync(STOCK_FILE)) return;
    const raw = fs.readFileSync(STOCK_FILE, "utf-8");
    const json = JSON.parse(raw);
    if (json?.status) stockState = { ...stockState, ...json };
  } catch (e) {
    console.error("Failed to load stock.json:", e);
  }
}

function saveStock() {
  try {
    fs.writeFileSync(STOCK_FILE, JSON.stringify(stockState, null, 2));
  } catch (e) {
    console.error("Failed to save stock.json:", e);
  }
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

// ========= DISCORD UI BUILDERS =========
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("💸ORDER ROBUX — VIA COMMUNITY PAYOUT")
    .setDescription(
      [
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
  const isReady = stockState.status === "READY";
  return new ButtonBuilder()
    .setCustomId("ob_stock_info")
    .setLabel(isReady ? "📦 STOCK: READY" : "⛔ STOCK: HABIS")
    .setStyle(isReady ? ButtonStyle.Primary : ButtonStyle.Danger)
    .setDisabled(true);
}

function buildPanelComponents() {
  const isReady = stockState.status === "READY";

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ob_order_open_modal")
        .setLabel("💸ORDER ROBUX")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!isReady),
      buildStockStatusButton()
    )
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
      (m) =>
        m.author.id === client.user.id &&
        m.embeds?.[0]?.title?.includes("ORDER ROBUX")
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
  const modal = new ModalBuilder().setCustomId("ob_order_modal_submit").setTitle("Order OLENG BEACH");

  const username = new TextInputBuilder()
    .setCustomId("roblox_username")
    .setLabel("Username Roblox (tanpa @, bukan Display Name)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const qty = new TextInputBuilder()
    .setCustomId("qty")
    .setLabel("Jumlah (minimal 1000)")
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
  const days = Number.isFinite(order.robloxDaysInGroup)
    ? order.robloxDaysInGroup
    : 0;

  const joinLine = order.robloxJoinTime
    ? fmtDateID(order.robloxJoinTime)
    : "-";

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
        "Setelah transfer, kirim **bukti pembayaran (gambar)** di ticket ini.",
      ].join("\n")
    : [
        `👤 **Username Roblox:** \`${order.robloxUsername}\``,
        "",
        `📊 **Status Join Community:** ${eligibleLine}`,
        `📅 **Tanggal Join:** ${joinLine}`,
        "",
        `⚠️ Alasan: ${order.ineligibleReason || "Belum memenuhi syarat."}`,
        "",
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
        "✅ Setelah transfer, **kirim bukti transfer (gambar/ss)** di chat ticket ini.",
        "⚠️ Pastikan nominal & rekening benar.",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH" });
}

// ========= ACTIVITY / AUTO CLOSE =========
// Auto-close logic:
// - order.autoCloseEnabled === true  => sweep will close after inactivity cutoff
// - order.autoClosePaused === true   => sweep ignores order (paused), used after proof submitted
function touchActivity(order, reason = "activity") {
  order.lastActivityAt = nowIso();
  order.lastActivityReason = reason;
  orders.set(order.orderId, order);
  saveOrders();
}

async function deleteTicketChannel(channel, order, reasonText) {
  try {
    // update status dulu biar ke-save walau delete gagal
    order.status = "CLOSED";
    order.closedAt = nowIso();
    order.autoCloseEnabled = false;
    order.autoClosePaused = false;

    orders.set(order.orderId, order);
    saveOrders();

    // kasih notice (opsional)
    if (reasonText) {
      await channel.send(reasonText).catch(() => {});
    }

    // delete after 3 seconds biar message sempat kebaca
    setTimeout(async () => {
      try {
        await channel.delete("Ticket closed (deleted).");
      } catch (e) {
        console.error("Failed to delete channel:", e);

        // fallback kalau gagal delete: lock saja supaya tetap ketutup
        try {
          await channel.permissionOverwrites.edit(order.userId, { SendMessages: false }).catch(() => {});
          await channel.send("⚠️ Bot gagal menghapus channel (permission). Ticket dikunci sebagai fallback.").catch(() => {});
        } catch {}
      }
    }, 3000);

  } catch (e) {
    console.error("deleteTicketChannel error:", e);
  }
}

async function runAutoCloseSweep(client) {
  const cutoffMs = AUTO_CLOSE_MINUTES * 60 * 1000;
  const now = Date.now();

  for (const order of orders.values()) {
    if (!order?.channelId) continue;
    if (!order.autoCloseEnabled) continue;
    if (order.autoClosePaused) continue;
    if (order.status === "CLOSED" || order.status === "CANCELLED") continue;

    const last = order.lastActivityAt ? new Date(order.lastActivityAt).getTime() : 0;
    if (!last) continue;

    if (now - last >= cutoffMs) {
  try {
    const guild = await client.guilds.fetch(order.guildId);

    const ch = await guild.channels
      .fetch(order.channelId)
      .catch(() => null);

    if (!ch) continue; // 🔥 INI YANG PENTING

    await deleteTicketChannel(
      ch,
      order,
      `🔒 Ticket ditutup otomatis (inactivity ${AUTO_CLOSE_MINUTES} menit). Ticket akan dihapus...`
    );
  } catch (e) {
    console.error("Auto-close sweep error:", e);
  }
}
  }
}

// ========= DISCORD CLIENT =========
loadOrders();
loadStock();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  setInterval(() => runAutoCloseSweep(client), 60 * 1000).unref();

  const guild = await client.guilds.fetch(GUILD_ID);

  await guild.commands.set([
  new SlashCommandBuilder()
    .setName("stok")
    .setDescription("Ubah status stock")
    .addStringOption(option =>
      option
        .setName("status")
        .setDescription("Pilih status stock")
        .setRequired(true)
        .addChoices(
          { name: "ready", value: "READY" },
          { name: "habis", value: "HABIS" }
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("proses")
    .setDescription("Staff: proses order")
    .addStringOption(option =>
      option
        .setName("aksi")
        .setDescription("Aksi proses")
        .setRequired(true)
        .addChoices({ name: "selesai", value: "SELESAI" })
    )
    .addStringOption(option =>
      option
        .setName("order")
        .setDescription("Order ID (contoh: T-12345). Kosongkan jika jalankan di dalam ticket.")
        .setRequired(false)
    )
    .toJSON(),
]);

  console.log("Slash commands /stok & /proses registered.");

  await refreshPanelMessage(client);
});

// Track activity + detect payment proof
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    // Cari order berdasarkan channel
    const order = Array.from(orders.values()).find((o) => o.channelId === msg.channelId);
    if (!order) return;

    // ===== Activity handling =====
    // Semua chat (user/staff) bikin timer inactivity ke-reset (biar user bisa tanya-tanya)
    // KECUALI: kalau proof sudah masuk dan auto-close paused, kita tetap boleh touchActivity untuk info,
    // tapi sweep tetap skip karena paused.
    touchActivity(order, "chat_message");

    // ===== PROOF DETECTION =====
    // Hanya customer, dan hanya kalau status menunggu bukti
    if (order.status === "AWAITING_PROOF" && msg.author.id === order.userId) {
      const attachments = msg.attachments;
      if (!attachments || attachments.size === 0) return;

      const hasImage = [...attachments.values()].some(
        (a) => a.contentType && a.contentType.startsWith("image/")
      );

      if (hasImage) {
        order.status = "PROOF_SUBMITTED";
        order.proofSubmittedAt = nowIso();

        // STOP / PAUSE timer inactivity setelah bukti gambar masuk
        order.autoClosePaused = true;
        touchActivity(order, "proof_image_submitted");

        orders.set(order.orderId, order);
        saveOrders();

        await msg.channel.send(
          `✅ Bukti pembayaran diterima dari <@${order.userId}>.\n` +
            `👮‍♂️ Staff/Owner akan proses Robux kamu, mohon bersedia menunggu...`
        ).catch(() => {});
      }
      // kalau bukan gambar: tidak dianggap bukti, timer tetap berjalan normal (tidak pause)
    }
  } catch (e) {
    console.error("messageCreate error:", e);
  }
});

client.on("interactionCreate", async (i) => {
  try {
    // ===== SLASH COMMAND STOCK =====
if (i.isChatInputCommand() && i.commandName === "stok") {
  const member = await i.guild.members.fetch(i.user.id).catch(() => null);

  if (!isStaff(member)) {
    return i.reply({
      content: "Khusus staff/owner.",
      ephemeral: true
    });
  }

  const status = i.options.getString("status");

  if (!["READY", "HABIS"].includes(status)) {
    return i.reply({
      content: "Status tidak valid.",
      ephemeral: true
    });
  }

  stockState.status = status;
  stockState.updatedAt = nowIso();
  stockState.updatedBy = i.user.id;
  saveStock();

  await i.reply({
    content: `✅ Status stock diubah menjadi **${status}**.`,
    ephemeral: true
  });

  await refreshPanelMessage(client);
  return;
}

// ===== SLASH COMMAND PROSES =====
if (i.isChatInputCommand() && i.commandName === "proses") {
  const member = await i.guild.members.fetch(i.user.id).catch(() => null);

  if (!isStaff(member)) {
    return i.reply({ content: "Khusus staff/owner.", ephemeral: true });
  }

  const aksi = i.options.getString("aksi");
  const orderArg = i.options.getString("order"); // optional
  const channelId = i.channelId;

  if (aksi !== "SELESAI") {
    return i.reply({ content: "Aksi tidak valid.", ephemeral: true });
  }

  // Cari order: pakai orderId kalau diisi, kalau tidak cari dari channel sekarang
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

  // Pastikan command dijalankan di ticket yang benar
  if (order.channelId !== channelId) {
    return i.reply({
      content: "Order itu bukan untuk channel ini. Jalankan di channel ticket yang benar.",
      ephemeral: true,
    });
  }

  // Wajib sudah submit bukti
  if (order.status !== "PROOF_SUBMITTED" && order.status !== "AWAITING_PROOF") {
    return i.reply({ content: "Belum ada bukti pembayaran (gambar).", ephemeral: true });
  }

  // Set DONE + re-arm timer
  order.status = "DONE";
  order.doneAt = nowIso();
  order.autoClosePaused = false;
  order.autoCloseEnabled = true;
  touchActivity(order, "staff_done_command");

  orders.set(order.orderId, order);
  saveOrders();

  const now = new Date();
  const tanggal = now.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
  const jam = now.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });

  await i.reply({
    content: `✅ Proses selesai untuk **${order.orderId}**. Timer inactivity aktif lagi (${AUTO_CLOSE_MINUTES} menit).`,
    ephemeral: true,
  });

  await i.channel.send(
    `🎉 **ORDER BERHASIL DIKIRIM!** 🎉\n\n` +
      `👤 Username Roblox: \`${order.robloxUsername}\`\n` +
      `💎 Total Robux: **${fmtIDR(order.qty)}**\n` +
      `💰 Total Bayar: **Rp ${fmtIDR(order.total)}**\n` +
      `📅 Tanggal: **${tanggal}**\n` +
      `⏰ Jam: **${jam} WIB**\n\n` +
      `Silakan cek kembali Robux kamu.\n` +
      `Jika ada kendala, silakan hubungi staff/owner.\n\n` +
      `⏳ Ticket akan ditutup otomatis jika tidak ada aktivitas selama **${AUTO_CLOSE_MINUTES} menit**.`
  ).catch(() => {});

  return;
}
    // ORDER button -> modal
    if (i.isButton() && i.customId === "ob_order_open_modal") {

  if (stockState.status !== "READY") {
    return i.reply({
      content: "⛔ Stock sedang HABIS. Silakan tunggu sampai stock READY.",
      ephemeral: true
    });
  }

  return i.showModal(buildOrderModal());
}

    // Modal submit -> validate + create ticket (eligible/ineligible both)
    if (i.isModalSubmit() && i.customId === "ob_order_modal_submit") {
      await i.deferReply({ ephemeral: true });

      const robloxUsername = i.fields.getTextInputValue("roblox_username")?.trim()?.replace(/^@/, "");
      const qtyRaw = i.fields.getTextInputValue("qty")?.trim();
      const note = i.fields.getTextInputValue("note")?.trim();

      const qty = Number(String(qtyRaw || "").replace(/[^\d]/g, ""));
      if (!Number.isFinite(qty) || qty < 1000) {
        return i.editReply("Jumlah minimal 1000.");
      }

      // Eligibility
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

    // ✅ WAJIB: izin untuk BOT biar bisa kirim pesan ke ticket
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

        // status:
        // - if eligible => AWAITING_PAYMENT (buttons shown)
        // - if not eligible => INELIGIBLE
        status: eligibility.ok ? "AWAITING_PAYMENT" : "INELIGIBLE",

        paymentMethod: "SEABANK", // only method
        createdAt: nowIso(),
        lastActivityAt: nowIso(),

        // auto-close settings:
        autoCloseEnabled: true,  // always enabled initially
        autoClosePaused: false,  // paused only after proof submitted
      };

      orders.set(orderId, order);
      saveOrders();

      // Send initial message(s)
      const statusEmbed = buildCustomerStatusEmbed(order);

      if (order.robloxEligible) {
        await ticket.send({
          content: `Halo <@${user.id}> 👋\nBerikut detail order kamu. Silakan lanjut pembayaran via tombol di bawah.`,
          embeds: [statusEmbed],
          components: buildCustomerButtonsEligible(orderId),
        }).catch(() => {});

        if (order.note) {
          await ticket.send({ content: `📝 Catatan: ${order.note}` }).catch(() => {});
        }
      } else {
        await ticket.send({
          content: `Halo <@${user.id}> 👋\nKamu **belum memenuhi syarat** untuk order.`,
          embeds: [statusEmbed],
          components: buildCustomerButtonsIneligible(orderId),
        }).catch(() => {});
      }

      await i.editReply(`✅ Ticket dibuat: <#${ticket.id}>`);
      return;
    }

    if (!i.isButton()) return;
    if (!i.guild) return;

    // Parse customId
    const parts = i.customId.split(":");
    const key = parts[0];

    // Find orderId at last segment
    const orderId = parts[1] || parts[2];
    const order = orderId ? orders.get(orderId) : null;

    // Buttons that need valid order + correct channel
    const needsOrder = [
  "ob_bank",
  "ob_cancel_user",
  "ob_close_ineligible",
];
    if (needsOrder.includes(key)) {
      if (!order) return i.reply({ content: "Order tidak ditemukan.", ephemeral: true });
      if (i.channelId !== order.channelId) return i.reply({ content: "Tombol ini hanya valid di ticket ini.", ephemeral: true });
    }

    // BANK TRANSFER (customer)
    if (key === "ob_bank") {
      // only for eligible orders
      if (!order.robloxEligible) return i.reply({ content: "Order ini tidak eligible.", ephemeral: true });

      // Only customer or staff
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });

      // Set status to awaiting proof
      order.status = "AWAITING_PROOF";
      order.autoClosePaused = false; // still running until proof image arrives
      touchActivity(order, "bank_transfer_clicked");
      orders.set(order.orderId, order);
      saveOrders();

      await i.reply({ embeds: [buildSeaBankInstructions(order)] });
      await i.channel.send("📌 Setelah transfer, kirim **bukti pembayaran (gambar/ss)** di sini. Jika dalam **30 Menit** tidak kirim bukti pembayaran, order akan di close.").catch(() => {});
      return;
    }

    // CANCEL ORDER (customer) -> close ticket
    if (key === "ob_cancel_user") {
  const member = await i.guild.members.fetch(i.user.id).catch(() => null);
  const allowed = i.user.id === order.userId || isStaff(member);
  if (!allowed) return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });

  order.status = "CANCELLED";
  order.cancelledAt = nowIso();
  order.autoCloseEnabled = false;
  order.autoClosePaused = false;

  orders.set(order.orderId, order);
  saveOrders();

  await i.reply({ content: "❌ Order ditutup. Ticket akan dihapus dalam 3 detik...", ephemeral: true });

  await deleteTicketChannel(i.channel, order, "❌ Order ditutup oleh user. Ticket akan dihapus...");
  return;
}

    // CLOSE TICKET (ineligible)
    if (key === "ob_close_ineligible") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) return i.reply({ content: "Kamu tidak punya akses untuk ticket ini.", ephemeral: true });

      order.status = "CLOSED";
order.closedAt = nowIso();
order.autoCloseEnabled = false;
order.autoClosePaused = false;
orders.set(order.orderId, order);
saveOrders();

await i.reply({ content: "🔒 Ticket akan dihapus dalam 3 detik...", ephemeral: true });

await deleteTicketChannel(
  i.channel,
  order,
  "🔒 Ticket ditutup (ineligible). Ticket akan dihapus..."
);

return;
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (i.deferred || i.replied) {
      await i.followUp({ content: "Terjadi error. Coba lagi.", ephemeral: true }).catch(() => {});
    } else {
      await i.reply({ content: "Terjadi error. Coba lagi.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);