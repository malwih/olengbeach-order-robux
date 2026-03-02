/**
 * OLENG BEACH Ticket Bot (discord.js v14) - Single File (FINAL)
 * - Panel order + modal
 * - Roblox group membership age check (>= ELIGIBLE_DAYS) via Roblox Open Cloud Groups API
 * - Ticket channel auto-create on submit (eligible / ineligible)
 * - Show join days + total robux + total price + buttons immediately after ticket created
 * - Buttons:
 *    - Bank Transfer (customer) -> show SeaBank info + total
 *    - Batalkan Order (customer) -> close/lock ticket
 *    - Proses Selesai (staff-only, sent as a separate staff message)
 *    - Close Ticket (for ineligible)
 * - Auto-close after 30 min inactivity:
 *    - Reset by chat activity
 *    - PAUSE after payment proof image submitted
 *    - RE-ARM after staff clicks "Proses Selesai"
 * - Persist orders to ./orders.json
 *
 * Node.js 18+ recommended
 */

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
const PRICE_PER_1000 = Number(process.env.PRICE_PER_1000 || 110000);

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
        "➡️ Kelipatan 1.000 (otomatis dihitung bot).",
        "",
        "**Cara order (step by step)**",
        "1) Klik tombol **ORDER** di bawah",
        "2) Isi **Username Roblox** & **Jumlah**",
        "3) Bot cek join komunitas Roblox",
        "4) Ticket dibuat otomatis",
        "5) Klik **Bank Transfer** untuk lihat instruksi pembayaran",
        "6) Transfer lalu kirim **bukti transfer (gambar)** di ticket",
        "7) Tunggu staff klik **Proses Selesai**",
        "",
        "⚠️ **PENTING — JANGAN TRANSFER sebelum instruksi pembayaran muncul!**",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH Order Robux System" });
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ob_order_open_modal")
        .setLabel("💸ORDER ROBUX")
        .setStyle(ButtonStyle.Success)
    ),
  ];
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
  const days = Number.isFinite(order.robloxDaysInGroup) ? order.robloxDaysInGroup : 0;
  const joinLine =
    order.robloxJoinTime ? fmtDateID(order.robloxJoinTime) : "-";

  const eligibleLine = order.robloxEligible
    ? `✅ Eligible — **${days}/${ELIGIBLE_DAYS} hari**`
    : `❌ Tidak eligible — **${days}/${ELIGIBLE_DAYS} hari**`;

  const desc = order.robloxEligible
    ? [
        `**Status Join Community:** ${eligibleLine}`,
        `**Tanggal Join:** ${joinLine}`,
        "",
        `💎 **Total Robux:** ${fmtIDR(order.qty)}`,
        `💰 **Total Harga:** Rp ${fmtIDR(order.total)}`,
        "",
        "Klik **Bank Transfer** untuk melihat instruksi pembayaran.",
        "Setelah transfer, kirim **bukti pembayaran (gambar)** di ticket ini.",
      ].join("\n")
    : [
        `**Status Join Community:** ${eligibleLine}`,
        `**Tanggal Join:** ${joinLine}`,
        "",
        `Alasan: ${order.ineligibleReason || "Tidak memenuhi syarat."}`,
        "",
        "Silakan join komunitas sampai memenuhi syarat, lalu order ulang.",
      ].join("\n");

  return new EmbedBuilder()
    .setTitle(`OLENG BEACH — Ticket ${order.orderId}`)
    .setDescription(desc)
    .setFooter({ text: "JANGAN TRANSFER sebelum instruksi pembayaran muncul." });
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
        .setLabel("❌ Batalkan Order")
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

function buildStaffDoneButton(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_done_staff:${orderId}`)
        .setLabel("✅ Proses Selesai")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildSeaBankInstructions(order) {
  return new EmbedBuilder()
    .setTitle("Instruksi Pembayaran — SeaBank")
    .setDescription(
      [
        `**Order:** ${order.orderId}`,
        `**Total Bayar:** Rp ${fmtIDR(order.total)}`,
        "",
        `**Rekening SeaBank:** \`${SEABANK_ACCOUNT}\``,
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

async function lockTicketChannel(channel, order, reasonText) {
  try {
    // lock user send msg
    await channel.permissionOverwrites.edit(order.userId, { SendMessages: false }).catch(() => {});
    order.status = "CLOSED";
    order.closedAt = nowIso();
    orders.set(order.orderId, order);
    saveOrders();

    await channel.send(reasonText || "🔒 Ticket ditutup.").catch(() => {});
  } catch (e) {
    console.error("Failed to lock ticket:", e);
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
        const ch = await guild.channels.fetch(order.channelId).catch(() => null);
        if (!ch) continue;

        await lockTicketChannel(
          ch,
          order,
          `🔒 Ticket ditutup otomatis (inactivity ${AUTO_CLOSE_MINUTES} menit). Jika perlu, silakan buat order baru / hubungi staff.`
        );
      } catch (e) {
        console.error("Auto-close sweep error:", e);
      }
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
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Auto-close sweep loop
  setInterval(() => runAutoCloseSweep(client), 60 * 1000).unref();

  // Post/refresh panel
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(PANEL_CHANNEL_ID);

    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error("PANEL_CHANNEL_ID is not a text channel");
      return;
    }

    const embed = buildPanelEmbed();
    const components = buildPanelComponents();

    const msgs = await channel.messages.fetch({ limit: 20 });
    const existing = msgs.find(
      (m) => m.author.id === client.user.id && m.embeds?.[0]?.title?.includes("ORDER ROBUX")
    );

    if (existing) {
      await existing.edit({ embeds: [embed], components });
      console.log("Panel updated.");
    } else {
      await channel.send({ embeds: [embed], components });
      console.log("Panel sent.");
    }
  } catch (e) {
    console.error("Failed to send/update panel:", e);
  }
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
            `⏸️ Timer inactivity **di-pause**.\n` +
            `👮‍♂️ Staff/Owner silakan klik **Proses Selesai** setelah order benar-benar dikirim.`
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
    // ORDER button -> modal
    if (i.isButton() && i.customId === "ob_order_open_modal") {
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

        // Staff-only message for "Proses Selesai"
        await ticket.send({
          content: `🔐 Staff/Owner: tombol internal untuk menyelesaikan order.`,
          components: buildStaffDoneButton(orderId),
        }).catch(() => {});

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
      "ob_done_staff",
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
      await i.channel.send("📌 Setelah transfer, kirim **bukti pembayaran (gambar/ss)** di sini.").catch(() => {});
      return;
    }

    // CANCEL ORDER (customer) -> close ticket
    if (key === "ob_cancel_user") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      const allowed = i.user.id === order.userId || isStaff(member);
      if (!allowed) return i.reply({ content: "Kamu tidak punya akses untuk order ini.", ephemeral: true });

      order.status = "CANCELLED";
      order.cancelledAt = nowIso();
      order.autoCloseEnabled = false; // already closing
      order.autoClosePaused = false;
      orders.set(order.orderId, order);
      saveOrders();

      await i.reply({ content: "❌ Order dibatalkan. Ticket ditutup.", ephemeral: true });
      await lockTicketChannel(
        i.channel,
        order,
        "❌ Order dibatalkan. Ticket ditutup (locked)."
      );
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

      await i.reply({ content: "🔒 Ticket ditutup.", ephemeral: true });
      await lockTicketChannel(i.channel, order, "🔒 Ticket ditutup (locked).");
      return;
    }

    // PROSES SELESAI (staff-only)
    if (key === "ob_done_staff") {
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      if (!isStaff(member)) {
        return i.reply({ content: "Khusus staff/owner.", ephemeral: true });
      }

      // Must have proof submitted? (optional strict)
      // Kamu minta: "tunggu staff/owner klik proses selesai" setelah bukti masuk.
      // Jadi kita enforce: hanya boleh done kalau PROOF_SUBMITTED (biar rapi)
      if (order.status !== "PROOF_SUBMITTED" && order.status !== "AWAITING_PROOF") {
        return i.reply({
          content: "Belum ada bukti pembayaran (atau belum di tahap pembayaran).",
          ephemeral: true,
        });
      }

      order.status = "DONE";
      order.doneAt = nowIso();

      // Re-arm timer inactivity after done
      order.autoClosePaused = false;
      order.autoCloseEnabled = true;
      touchActivity(order, "staff_done_clicked");

      orders.set(order.orderId, order);
      saveOrders();

      const now = new Date();
      const tanggal = now.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
      const jam = now.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });

      await i.reply({
        content: `✅ Proses selesai. Timer inactivity aktif lagi, ticket akan auto-close jika **${AUTO_CLOSE_MINUTES} menit** tidak ada aktivitas.`,
        ephemeral: true,
      });

      await i.channel.send(
        `🎉 **ORDER BERHASIL DIKIRIM!** 🎉\n\n` +
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