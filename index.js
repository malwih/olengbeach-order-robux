/**
 * OLENG BEACH Ticket Bot (discord.js v14) - Single File
 * - Panel order + modal
 * - Roblox group membership age check (>= ELIGIBLE_DAYS) via Roblox Open Cloud Groups API
 * - Ticket channel auto-create on submit (eligible only)
 * - Payment SeaBank only + auto-detect payment proof (attachments)
 * - Staff-only controls + "Proses Selesai" => auto-close after 30 min inactivity
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

// Auto-close after staff presses "Proses Selesai"
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
  if (!membership) return { ok: false, reason: "User belum join komunitas Roblox (Group)." };

  const joinTimeIso = extractMembershipJoinTime(membership);
  if (!joinTimeIso) {
    return {
      ok: false,
      reason: "User terdeteksi member, tapi API tidak mengembalikan tanggal join. Tidak bisa validasi 14 hari.",
      userId,
      joinTime: null,
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
  };
}

// ========= DISCORD UI BUILDERS =========
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("OLENG BEACH — Order Robux")
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
        "1) Klik tombol **ORDER** di bawah",
        "2) Isi **Username Roblox** & **Jumlah**",
        "3) Bot cek join komunitas Roblox",
        "4) Ticket dibuat otomatis",
        "5) Staff klik **Process** → pilih **SeaBank**",
        "6) Customer transfer lalu kirim **bukti transfer** di ticket",
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
        .setLabel("ORDER")
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

function buildOrderEmbed(order) {
  const statusMap = {
    AWAITING_STAFF: "Awaiting Staff",
    PAYMENT_SELECTION: "Select Payment Method",
    AWAITING_PAYMENT: "Awaiting Payment",
    PROOF_SUBMITTED: "Proof Submitted",
    PAID_CHECK: "Paid (Checking)",
    SENT: "Sent",
    DONE: "Done",
    CLOSED: "Closed",
    CANCELLED: "Cancelled",
  };

  const statusText = statusMap[order.status] || order.status;
  const eligibilityLine = order.robloxEligible
    ? `✅ Eligible (join ${order.robloxDaysInGroup} hari)`
    : `❌ Not eligible`;

  return new EmbedBuilder()
    .setTitle(`OLENG BEACH — Order ${order.orderId}`)
    .addFields(
      { name: "Customer", value: `<@${order.userId}>`, inline: true },
      { name: "Username Roblox", value: order.robloxUsername, inline: true },
      { name: "Roblox User ID", value: String(order.robloxUserId || "-"), inline: true },
      { name: "Status Komunitas", value: eligibilityLine, inline: true },
      { name: "Join Komunitas", value: order.robloxJoinTime ? fmtDateID(order.robloxJoinTime) : "-", inline: true },
      { name: "Jumlah", value: `${fmtIDR(order.qty)} unit`, inline: true },
      { name: "Total", value: `Rp ${fmtIDR(order.total)}`, inline: true },
      { name: "Status", value: statusText, inline: true },
      { name: "Handler", value: order.handlerId ? `<@${order.handlerId}>` : "-", inline: true }
    )
    .setFooter({ text: "JANGAN TRANSFER sebelum instruksi pembayaran muncul." });
}

function buildStaffControls(orderId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ob_process:${orderId}`).setLabel("Process").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ob_paid:${orderId}`).setLabel("Mark Paid").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ob_sent:${orderId}`).setLabel("Sent").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ob_done:${orderId}`).setLabel("Proses Selesai").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ob_resendpay:${orderId}`).setLabel("Resend Payment Info").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ob_close:${orderId}`).setLabel("Close (Lock)").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ob_cancel:${orderId}`).setLabel("Batalkan").setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildPaymentSelection(orderId) {
  const embed = new EmbedBuilder()
    .setTitle("Pilih Metode Pembayaran")
    .setDescription("Metode pembayaran tersedia:")
    .addFields({ name: "Metode", value: "• SeaBank", inline: false });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ob_pay:SEABANK:${orderId}`).setLabel("SeaBank").setStyle(ButtonStyle.Primary)
  );

  return { embed, components: [row] };
}

function buildSeaBankInstructions(order) {
  return new EmbedBuilder()
    .setTitle("Instruksi Pembayaran — SeaBank")
    .setDescription(
      [
        `**Order:** ${order.orderId}`,
        `**Total:** Rp ${fmtIDR(order.total)}`,
        "",
        `**Rekening SeaBank:** \`${SEABANK_ACCOUNT}\``,
        `**A/N:** ${SEABANK_NAME}`,
        "",
        "✅ Setelah transfer, **kirim bukti transfer** (foto/ss/file) di chat ticket ini.",
        "⚠️ Pastikan nominal & rekening benar.",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH" });
}

// ========= TICKET ACTIVITY / AUTO CLOSE =========
function touchActivity(order, reason = "activity") {
  order.lastActivityAt = nowIso();
  // kalau auto close armed, tetap armed tapi timer dihitung ulang karena lastActivity berubah
  orders.set(order.orderId, order);
  saveOrders();
}

async function lockTicketChannel(channel, order) {
  try {
    await channel.permissionOverwrites.edit(order.userId, { SendMessages: false }).catch(() => {});
    order.status = "CLOSED";
    order.closedAt = nowIso();
    orders.set(order.orderId, order);
    saveOrders();

    await channel.send("🔒 Ticket ditutup otomatis (inactivity). Jika perlu lanjut, buat order baru / hubungi staff.");
  } catch (e) {
    console.error("Failed to lock ticket:", e);
  }
}

async function runAutoCloseSweep(client) {
  const cutoffMs = AUTO_CLOSE_MINUTES * 60 * 1000;
  const now = Date.now();

  for (const order of orders.values()) {
    if (!order?.channelId) continue;
    if (!order.autoCloseArmed) continue; // hanya setelah staff tekan "Proses Selesai"
    if (order.status === "CLOSED" || order.status === "CANCELLED") continue;

    const last = order.lastActivityAt ? new Date(order.lastActivityAt).getTime() : 0;
    if (!last) continue;

    if (now - last >= cutoffMs) {
      try {
        const guild = await client.guilds.fetch(order.guildId);
        const ch = await guild.channels.fetch(order.channelId).catch(() => null);
        if (!ch) continue;

        await lockTicketChannel(ch, order);
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
      (m) => m.author.id === client.user.id && m.embeds?.[0]?.title?.includes("OLENG BEACH — Order Robux")
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

    // Find order by channelId
    const order = Array.from(orders.values()).find((o) => o.channelId === msg.channelId);
    if (!order) return;

    // Touch activity for any message in ticket
    touchActivity(order, "message");

    // Auto-detect proof: ticket owner sends attachment while awaiting payment
    const hasAttachment = msg.attachments?.size > 0;
    if (hasAttachment && msg.author.id === order.userId && (order.status === "AWAITING_PAYMENT" || order.status === "PAYMENT_SELECTION")) {
      order.status = "PROOF_SUBMITTED";
      order.proofSubmittedAt = nowIso();
      orders.set(order.orderId, order);
      saveOrders();

      await msg.channel.send(
        `✅ Bukti pembayaran diterima dari <@${order.userId}>.\n` +
        `👮‍♂️ Staff silakan cek, lalu tekan **Mark Paid** jika valid.`
      ).catch(() => {});
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

    // Modal submit -> validate + create ticket
    if (i.isModalSubmit() && i.customId === "ob_order_modal_submit") {
      // Ini kunci biar eligible gak “terjadi error”: kita ACK dulu
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

      if (!eligibility.ok) {
        return i.editReply(`Tidak bisa order: ${eligibility.reason}`);
      }

      // Create ticket + order
      const orderId = newOrderId();
      const total = computeTotal(qty);

      const guild = await client.guilds.fetch(GUILD_ID);
      const user = i.user;

      // Important: any failure below should not break interaction
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
        robloxUserId: eligibility.userId,
        robloxJoinTime: eligibility.joinTime,
        robloxDaysInGroup: eligibility.daysInGroup ?? null,
        robloxEligible: true,
        qty,
        total,
        note: note || "",
        status: "AWAITING_STAFF",
        handlerId: null,
        paymentMethod: null,
        createdAt: nowIso(),
        lastActivityAt: nowIso(),
        autoCloseArmed: false,
      };

      orders.set(orderId, order);
      saveOrders();

      const embed = buildOrderEmbed(order);

      await ticket.send({
        content: `Halo <@${user.id}>, ticket kamu sudah dibuat. Tunggu staff klik **Process** ya.`,
        embeds: [embed],
        components: buildStaffControls(orderId),
      }).catch(() => {});

      if (order.note) {
        await ticket.send({ content: `📝 Catatan: ${order.note}` }).catch(() => {});
      }

      await i.editReply(`✅ Ticket dibuat: <#${ticket.id}>`);
      return;
    }

    // Buttons
    if (i.isButton()) {
      // Staff action buttons
      if (i.customId.startsWith("ob_")) {
        const member = await i.guild.members.fetch(i.user.id).catch(() => null);

        // Payment button is NOT staff-only (owner can press)
        const isPayment = i.customId.startsWith("ob_pay:");
        const staffOnlyActions = ["ob_process", "ob_paid", "ob_sent", "ob_done", "ob_close", "ob_resendpay", "ob_cancel"];

        const [action, p1, p2] = i.customId.split(":"); // action[:method][:orderId] or action:orderId

        if (!isPayment && staffOnlyActions.includes(action) && !isStaff(member)) {
          return i.reply({ content: "Khusus staff.", ephemeral: true });
        }

        // ====== Payment selection (SeaBank) ======
        if (isPayment) {
          const method = p1;
          const orderId = p2;
          const order = orders.get(orderId);
          if (!order) return i.reply({ content: "Order tidak ditemukan.", ephemeral: true });
          if (i.channelId !== order.channelId) return i.reply({ content: "Tombol ini hanya untuk ticket ini.", ephemeral: true });

          const allowed = i.user.id === order.userId || isStaff(member);
          if (!allowed) return i.reply({ content: "Kamu tidak punya akses memilih pembayaran order ini.", ephemeral: true });

          if (method !== "SEABANK") return i.reply({ content: "Metode tidak tersedia.", ephemeral: true });

          order.paymentMethod = "SEABANK";
          order.status = "AWAITING_PAYMENT";
          touchActivity(order, "pay_select");

          await i.reply({ embeds: [buildSeaBankInstructions(order)] });
          await i.channel.send("📌 Kirim **bukti transfer** (foto/ss/file) di sini setelah pembayaran.").catch(() => {});
          return;
        }

        // ====== Staff actions ======
        const orderId = p1;
        const order = orders.get(orderId);
        if (!order) return i.reply({ content: "Order tidak ditemukan.", ephemeral: true });
        if (i.channelId !== order.channelId) return i.reply({ content: "Tombol ini hanya valid di ticket ini.", ephemeral: true });

        // Set handler
        if (!order.handlerId) order.handlerId = i.user.id;

        if (action === "ob_process") {
          order.status = "PAYMENT_SELECTION";
          touchActivity(order, "process");

          const { embed, components } = buildPaymentSelection(orderId);
          await i.reply({ embeds: [embed], components });

          // refresh main embed (the one with buttons)
          const updated = buildOrderEmbed(order);
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          return;
        }

        if (action === "ob_paid") {
          order.status = "PAID_CHECK";
          touchActivity(order, "paid");

          const updated = buildOrderEmbed(order);
          await i.reply({ content: "✅ Status diubah: Paid (Checking).", ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          await i.channel.send("✅ Staff menandai pembayaran: **PAID (Checking)**.").catch(() => {});
          return;
        }

        if (action === "ob_sent") {
          order.status = "SENT";
          touchActivity(order, "sent");

          const updated = buildOrderEmbed(order);
          await i.reply({ content: "✅ Status diubah: Sent.", ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          await i.channel.send("✅ Order ditandai **SENT** oleh staff.").catch(() => {});
          return;
        }

        if (action === "ob_done") {
          // Staff-only: arm auto-close inactivity
          order.status = "DONE";
          order.autoCloseArmed = true;
          order.autoCloseMinutes = AUTO_CLOSE_MINUTES;
          touchActivity(order, "done"); // set lastActivityAt now

          const updated = buildOrderEmbed(order);
          await i.reply({ content: `✅ Proses selesai. Ticket akan auto-tutup jika **${AUTO_CLOSE_MINUTES} menit** tidak ada aktivitas.`, ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          await i.channel.send(
            `✅ **PROSES SELESAI**.\n` +
            `⏳ Ticket akan ditutup otomatis jika tidak ada aktivitas selama **${AUTO_CLOSE_MINUTES} menit**.`
          ).catch(() => {});
          return;
        }

        if (action === "ob_resendpay") {
          if (order.paymentMethod === "SEABANK") {
            touchActivity(order, "resendpay");
            await i.channel.send({ embeds: [buildSeaBankInstructions(order)] }).catch(() => {});
            await i.reply({ content: "Payment info dikirim ulang.", ephemeral: true });
          } else {
            await i.reply({ content: "User belum memilih metode pembayaran.", ephemeral: true });
          }
          return;
        }

        if (action === "ob_cancel") {
          order.status = "CANCELLED";
          touchActivity(order, "cancel");

          const updated = buildOrderEmbed(order);
          await i.reply({ content: "❌ Order dibatalkan.", ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          await i.channel.send("❌ Order dibatalkan oleh staff.").catch(() => {});
          return;
        }

        if (action === "ob_close") {
          // Lock immediately (manual)
          order.status = "CLOSED";
          order.closedAt = nowIso();
          orders.set(orderId, order);
          saveOrders();

          await i.reply({ content: "🔒 Ticket akan ditutup (lock).", ephemeral: true });
          await i.channel.permissionOverwrites.edit(order.userId, { SendMessages: false }).catch(() => {});
          await i.channel.send("🔒 Ticket ditutup (locked).").catch(() => {});
          return;
        }
      }
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