/**
 * OLENG BEACH Ticket Bot (discord.js v14) - Single File
 * Features:
 * - Order panel with modal (Roblox username, qty, note)
 * - Checks Roblox group membership age >= ELIGIBLE_DAYS via Roblox Open Cloud Groups API
 * - Creates ticket channel, staff controls, payment via SeaBank only
 * - Persists orders to ./orders.json
 *
 * Requires Node.js 18+ (fetch built-in)
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

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");
if (!PANEL_CHANNEL_ID) throw new Error("Missing PANEL_CHANNEL_ID");
if (!TICKET_CATEGORY_ID) throw new Error("Missing TICKET_CATEGORY_ID");
if (!STAFF_ROLE_ID) throw new Error("Missing STAFF_ROLE_ID");
if (!ROBLOX_API_KEY) throw new Error("Missing ROBLOX_API_KEY (Roblox Open Cloud API key)");

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
  // T-04192 style
  const n = Math.floor(10000 + Math.random() * 90000);
  return `T-${n}`;
}

function fmtIDR(n) {
  return new Intl.NumberFormat("id-ID").format(n);
}

function fmtDateID(d) {
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.floor(ms / 86400000);
}

function isStaff(member) {
  return member?.roles?.cache?.has(STAFF_ROLE_ID);
}

// ========= ROBLOX HELPERS =========

async function robloxUsernameToUserId(username) {
  // POST users.roblox.com/v1/usernames/users (must be POST) :contentReference[oaicite:3]{index=3}
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
  // Open Cloud Groups API: List Group Memberships :contentReference[oaicite:4]{index=4}
  // Filter example: filter=user == 'users/<id>' :contentReference[oaicite:5]{index=5}
  const filter = encodeURIComponent(`user == 'users/${userId}'`);
  const url = `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships?filter=${filter}&pageSize=10`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": ROBLOX_API_KEY,
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Roblox membership fetch failed: ${r.status} ${t}`);
  }

  const json = await r.json();

  // The response typically has memberships array; fields can include createTime/startTime-like timestamps.
  // We'll defensively search for time fields.
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
  // try common fields:
  // createTime, createdTime, create_time, joinedTime, joinTime, startTime, createdAt
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
    return { ok: false, reason: "User belum join komunitas Roblox (Group)." };
  }

  const joinTimeIso = extractMembershipJoinTime(membership);
  // Kalau API tidak mengembalikan join time, kita tetap bisa “member” tapi tidak bisa hitung 14 hari.
  if (!joinTimeIso) {
    return {
      ok: false,
      reason:
        "User terdeteksi member, tapi API tidak mengembalikan tanggal join. Tidak bisa validasi 14 hari (cek field createTime/joinTime di response).",
      userId,
      joinTime: null,
    };
  }

  const now = new Date().toISOString();
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
    .setTitle("OLENG BEACH — Order")
    .setDescription(
      [
        "**Syarat sebelum order**",
        `• Wajib join komunitas Roblox minimal **${ELIGIBLE_DAYS} hari**`,
        "",
        "**Cara order (step by step)**",
        "1) Klik tombol **ORDER** di bawah",
        "2) Isi **Username Roblox** & **Jumlah**",
        "3) Bot cek join komunitas Roblox",
        "4) Ticket dibuat, tunggu staff klik **Process**",
        "5) Pilih pembayaran **SeaBank** → ikuti instruksi",
        "6) Kirim **bukti transfer** di ticket",
        "",
        "⚠️ **PENTING — JANGAN TRANSFER sebelum instruksi pembayaran muncul!**",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH Ticket System" });
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

function computeTotal(qty) {
  // Pricing: PRICE_PER_1000 per 1000 unit
  const blocks = qty / 1000;
  return Math.round(blocks * PRICE_PER_1000);
}

function buildOrderEmbed(order) {
  const statusMap = {
    AWAITING_STAFF: "Awaiting Staff",
    PAYMENT_SELECTION: "Select Payment Method",
    AWAITING_PAYMENT: "Awaiting Payment",
    PAID_CHECK: "Paid (Checking)",
    SENT: "Sent",
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
      new ButtonBuilder().setCustomId(`ob_close:${orderId}`).setLabel("Close").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ob_resendpay:${orderId}`).setLabel("Resend Payment Info").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ob_cancel:${orderId}`).setLabel("Batalkan Order").setStyle(ButtonStyle.Danger)
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
        "✅ Setelah transfer, **kirim bukti transfer** di chat ticket ini.",
        "⚠️ Pastikan nominal & rekening benar.",
      ].join("\n")
    )
    .setFooter({ text: "OLENG BEACH" });
}

// ========= DISCORD CLIENT =========
loadOrders();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed for permissions checks
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Post/refresh the order panel
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(PANEL_CHANNEL_ID);

    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error("PANEL_CHANNEL_ID is not a text channel");
      return;
    }

    const embed = buildPanelEmbed();
    const components = buildPanelComponents();

    // Try to find existing panel message sent by bot
    const msgs = await channel.messages.fetch({ limit: 20 });
    const existing = msgs.find((m) => m.author.id === client.user.id && m.embeds?.[0]?.title?.includes("OLENG BEACH"));

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

client.on("interactionCreate", async (i) => {
  try {
    // ORDER button -> modal
    if (i.isButton() && i.customId === "ob_order_open_modal") {
      return i.showModal(buildOrderModal());
    }

    // Modal submit -> validate + create ticket
    if (i.isModalSubmit() && i.customId === "ob_order_modal_submit") {
      await i.deferReply({ ephemeral: true });

      const robloxUsername = i.fields.getTextInputValue("roblox_username")?.trim()?.replace(/^@/, "");
      const qtyRaw = i.fields.getTextInputValue("qty")?.trim();
      const note = i.fields.getTextInputValue("note")?.trim();

      const qty = Number(String(qtyRaw || "").replace(/[^\d]/g, ""));
      if (!Number.isFinite(qty) || qty < 1000) {
        return i.editReply("Jumlah minimal 1000.");
      }

      // Check Roblox group eligibility (>= 14 days)
      let eligibility;
      try {
        eligibility = await checkRobloxGroupEligibility(robloxUsername);
      } catch (e) {
        console.error(e);
        return i.editReply(
          "Gagal cek komunitas Roblox. Pastikan ROBLOX_API_KEY benar & punya akses ke group. Coba lagi."
        );
      }

      if (!eligibility.ok) {
        return i.editReply(`Tidak bisa order: ${eligibility.reason}`);
      }

      const orderId = newOrderId();
      const total = computeTotal(qty);

      const guild = await client.guilds.fetch(GUILD_ID);
      const user = i.user;

      // Create ticket channel
      const ticketName = `oleng-beach-${orderId}`.toLowerCase();
      const ticket = await guild.channels.create({
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
        createdAt: new Date().toISOString(),
      };

      orders.set(orderId, order);
      saveOrders();

      const embed = buildOrderEmbed(order);

      await ticket.send({
        content: `Halo <@${user.id}>, ticket kamu sudah dibuat. Tunggu staff klik **Process** ya.`,
        embeds: [embed],
        components: buildStaffControls(orderId),
      });

      if (order.note) {
        await ticket.send({ content: `📝 Catatan: ${order.note}` });
      }

      await i.editReply(`Ticket dibuat: <#${ticket.id}>`);
      return;
    }

    // Staff buttons (process/paid/sent/close/resend/cancel)
    if (i.isButton()) {
      const [action, rest] = i.customId.split(":");
      const member = await i.guild.members.fetch(i.user.id).catch(() => null);

      const needsStaff = ["ob_process", "ob_paid", "ob_sent", "ob_close", "ob_resendpay", "ob_cancel"].includes(action);
      if (needsStaff && !isStaff(member)) {
        return i.reply({ content: "Khusus staff.", ephemeral: true });
      }

      if (needsStaff) {
        const orderId = rest;
        const order = orders.get(orderId);
        if (!order) return i.reply({ content: "Order tidak ditemukan.", ephemeral: true });

        // Ensure this is the correct channel
        if (i.channelId !== order.channelId) {
          return i.reply({ content: "Tombol ini hanya valid di channel ticket order ini.", ephemeral: true });
        }

        // Set handler if empty
        if (!order.handlerId) order.handlerId = i.user.id;

        if (action === "ob_process") {
          order.status = "PAYMENT_SELECTION";
          orders.set(orderId, order);
          saveOrders();

          const { embed, components } = buildPaymentSelection(orderId);
          await i.reply({ embeds: [embed], components });
          // also refresh main embed
          const updated = buildOrderEmbed(order);
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          return;
        }

        if (action === "ob_paid") {
          order.status = "PAID_CHECK";
          orders.set(orderId, order);
          saveOrders();

          const updated = buildOrderEmbed(order);
          await i.reply({ content: "Status diubah: Paid (Checking).", ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          return;
        }

        if (action === "ob_sent") {
          order.status = "SENT";
          orders.set(orderId, order);
          saveOrders();

          const updated = buildOrderEmbed(order);
          await i.reply({ content: "Status diubah: Sent.", ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          await i.channel.send("✅ Order ditandai **SENT** oleh staff.");
          return;
        }

        if (action === "ob_resendpay") {
          if (order.paymentMethod === "SEABANK") {
            await i.channel.send({ embeds: [buildSeaBankInstructions(order)] });
            await i.reply({ content: "Payment info dikirim ulang.", ephemeral: true });
          } else {
            await i.reply({ content: "User belum memilih metode pembayaran.", ephemeral: true });
          }
          return;
        }

        if (action === "ob_cancel") {
          order.status = "CANCELLED";
          orders.set(orderId, order);
          saveOrders();

          const updated = buildOrderEmbed(order);
          await i.reply({ content: "Order dibatalkan.", ephemeral: true });
          await i.message.edit({ embeds: [updated], components: buildStaffControls(orderId) }).catch(() => {});
          await i.channel.send("❌ Order dibatalkan oleh staff.");
          return;
        }

        if (action === "ob_close") {
          order.status = "CLOSED";
          orders.set(orderId, order);
          saveOrders();

          await i.reply({ content: "Ticket akan ditutup (lock).", ephemeral: true });

          // Lock channel (remove user's send permission)
          await i.channel.permissionOverwrites.edit(order.userId, {
            SendMessages: false,
          });

          await i.channel.send("🔒 Ticket ditutup (locked). Jika perlu buka lagi, hubungi staff.");
          return;
        }
      }

      // Payment button (SEABANK) - allowed for ticket owner (or staff)
      if (i.customId.startsWith("ob_pay:")) {
        const [, method, orderId] = i.customId.split(":");
        const order = orders.get(orderId);
        if (!order) return i.reply({ content: "Order tidak ditemukan.", ephemeral: true });

        if (i.channelId !== order.channelId) {
          return i.reply({ content: "Tombol ini hanya valid di channel ticket order ini.", ephemeral: true });
        }

        // Only ticket owner or staff can press
        const member = await i.guild.members.fetch(i.user.id).catch(() => null);
        const allowed = i.user.id === order.userId || isStaff(member);
        if (!allowed) return i.reply({ content: "Kamu tidak punya akses untuk memilih pembayaran order ini.", ephemeral: true });

        if (method !== "SEABANK") return i.reply({ content: "Metode tidak tersedia.", ephemeral: true });

        order.paymentMethod = "SEABANK";
        order.status = "AWAITING_PAYMENT";
        orders.set(orderId, order);
        saveOrders();

        await i.reply({ embeds: [buildSeaBankInstructions(order)] });

        // Also refresh the main embed message if possible
        // (We don't know which message is the main one; leave it as-is.)
        return;
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