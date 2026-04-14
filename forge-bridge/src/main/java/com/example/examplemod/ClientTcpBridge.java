package com.example.examplemod;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.BooleanProperty;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.block.state.properties.IntegerProperty;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Client-side TCP bridge for Node -> Minecraft client control.
 * Target: Minecraft 1.20.1 + Forge 47.10.4
 */
public class ClientTcpBridge {

    // =========================
    // Lifecycle
    // =========================
    private static volatile boolean started = false;

    // Default OFF to avoid interleaving async TEL lines with simple request/response test clients (PowerShell, etc.)
    private static volatile boolean telemetryEnabled = false;

    private static final Object OUT_LOCK = new Object();
    private static IntegerProperty findAgeProperty(BlockState st) {
        for (Property<?> p : st.getProperties()) {
            if (p instanceof IntegerProperty ip && p.getName().equalsIgnoreCase("age")) {
                return ip;
            }
        }
        return null;
    }
    private static String handleSenseCrops(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        int r = 8;
        String[] p = msg.split("\\s+");
        if (p.length >= 2) {
            try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
        }
        final int radius = Math.max(2, Math.min(48, r));

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }

                BlockPos origin = mc.player.blockPosition();
                StringBuilder sb = new StringBuilder("OK:crops ");

                boolean any = false;

                for (int dx = -radius; dx <= radius; dx++) {
                    for (int dy = -3; dy <= 3; dy++) {
                        for (int dz = -radius; dz <= radius; dz++) {
                            BlockPos pos = origin.offset(dx, dy, dz);
                            BlockState st = mc.level.getBlockState(pos);
                            Block b = st.getBlock();

                            // quick filter: only blocks with age property
                            IntegerProperty ageProp = findAgeProperty(st);
                            if (ageProp == null) continue;

                            int age = st.getValue(ageProp);
                            int max = getMaxAge(ageProp);
                            boolean ready = (age >= max);

                            if (any) sb.append(';');
                            any = true;

                            // format: x,y,z=blockId age/max ready
                            String bid = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(b).toString();
                            sb.append(pos.getX()).append(',').append(pos.getY()).append(',').append(pos.getZ())
                                    .append('=').append(bid)
                                    .append(' ').append(age).append('/').append(max)
                                    .append(' ').append(ready ? "ready" : "grow");
                        }
                    }
                }

                if (!any) sb.append("none");
                res[0] = sb.toString();
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1400, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }
    private static String handleCropStatus(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        String[] p = msg.split("\\s+");
        if (p.length != 4) return "ERR:usage CROP:STATUS <x> <y> <z>";

        int x,y,z;
        try { x=Integer.parseInt(p[1]); y=Integer.parseInt(p[2]); z=Integer.parseInt(p[3]); }
        catch (Exception e) { return "ERR:bad_coords"; }

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }
                BlockPos pos = new BlockPos(x,y,z);
                BlockState st = mc.level.getBlockState(pos);

                IntegerProperty ageProp = findAgeProperty(st);
                if (ageProp == null) { res[0] = "ERR:not_ageable"; return; }

                int age = st.getValue(ageProp);
                int max = getMaxAge(ageProp);
                boolean ready = age >= max;

                String bid = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
                res[0] = "OK:crop " + bid + " age=" + age + " max=" + max + " ready=" + (ready ? "true" : "false");
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(650, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }
    private static String handleCropHarvest(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        String[] p = msg.split("\\s+");
        if (p.length != 4) return "ERR:usage CROP:HARVEST <x> <y> <z>";

        int x,y,z;
        try { x=Integer.parseInt(p[1]); y=Integer.parseInt(p[2]); z=Integer.parseInt(p[3]); }
        catch (Exception e) { return "ERR:bad_coords"; }

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }
                BlockPos pos = new BlockPos(x,y,z);

                // range check
                Vec3 eye = mc.player.getEyePosition();
                Vec3 hit = Vec3.atCenterOf(pos);
                if (eye.distanceTo(hit) > REACH_DIST) { res[0] = "ERR:too_far"; return; }

                mc.gameMode.startDestroyBlock(pos, Direction.UP);
                mc.player.swing(InteractionHand.MAIN_HAND);

                res[0] = "OK:harvest_sent";
            } catch (Exception e) {
                res[0] = "ERR:harvest_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(650, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleCropPlant(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        String[] p = msg.split("\\s+");
        if (p.length != 4) return "ERR:usage CROP:PLANT <x> <y> <z>";

        int x,y,z;
        try { x=Integer.parseInt(p[1]); y=Integer.parseInt(p[2]); z=Integer.parseInt(p[3]); }
        catch (Exception e) { return "ERR:bad_coords"; }

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }

                BlockPos pos = new BlockPos(x,y,z);
                Vec3 eye = mc.player.getEyePosition();
                Vec3 hit = Vec3.atCenterOf(pos);
                if (eye.distanceTo(hit) > REACH_DIST) { res[0] = "ERR:too_far"; return; }

                BlockHitResult bhr = new BlockHitResult(
                        new Vec3(x + 0.5, y + 1.0, z + 0.5),
                        Direction.UP,
                        pos,
                        false
                );

                var result = mc.gameMode.useItemOn(mc.player, InteractionHand.MAIN_HAND, bhr);
                res[0] = "OK:plant_sent result=" + result;
            } catch (Exception e) {
                res[0] = "ERR:plant_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(650, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleSenseChests(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        int r = 16;
        String[] p = msg.split("\\s+");
        if (p.length >= 2) {
            try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
        }
        final int radius = Math.max(2, Math.min(64, r));

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }

                BlockPos origin = mc.player.blockPosition();
                StringBuilder sb = new StringBuilder("OK:chests ");
                boolean any = false;

                for (int dx = -radius; dx <= radius; dx++) {
                    for (int dy = -4; dy <= 4; dy++) {
                        for (int dz = -radius; dz <= radius; dz++) {
                            BlockPos pos = origin.offset(dx, dy, dz);
                            BlockState st = mc.level.getBlockState(pos);
                            Block b = st.getBlock();

                            ResourceLocation bid = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(b);
                            if (bid == null) continue;

                            String sid = bid.toString();

                            // Chest-like blocks only
                            if (!sid.equals("minecraft:chest") &&
                                    !sid.equals("minecraft:trapped_chest") &&
                                    !sid.equals("minecraft:barrel")) {
                                continue;
                            }

                            // Normalize double chest: keep only one half to avoid duplicates
                            if ((sid.equals("minecraft:chest") || sid.equals("minecraft:trapped_chest"))
                                    && st.hasProperty(net.minecraft.world.level.block.ChestBlock.TYPE)) {
                                var type = st.getValue(net.minecraft.world.level.block.ChestBlock.TYPE);
                                if (type != net.minecraft.world.level.block.state.properties.ChestType.SINGLE) {
                                    Direction facing = st.getValue(net.minecraft.world.level.block.ChestBlock.FACING);
                                    Direction leftDir = facing.getClockWise();
                                    Direction rightDir = facing.getCounterClockWise();

                                    BlockPos otherPos = switch (type) {
                                        case LEFT -> pos.relative(rightDir);
                                        case RIGHT -> pos.relative(leftDir);
                                        default -> null;
                                    };

                                    if (otherPos != null) {
                                        // keep lexicographically smaller half only
                                        boolean keepThis =
                                                pos.getX() < otherPos.getX() ||
                                                        (pos.getX() == otherPos.getX() && pos.getY() < otherPos.getY()) ||
                                                        (pos.getX() == otherPos.getX() && pos.getY() == otherPos.getY() && pos.getZ() <= otherPos.getZ());

                                        if (!keepThis) continue;
                                    }
                                }
                            }

                            if (any) sb.append(';');
                            any = true;
                            sb.append(pos.getX()).append(',').append(pos.getY()).append(',').append(pos.getZ());
                        }
                    }
                }

                if (!any) sb.append("none");
                res[0] = sb.toString();
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1400, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }
    
    private static String handleSenseEnv(String msg) {
    Minecraft mc = Minecraft.getInstance();
    final String[] res = new String[1];
    CountDownLatch latch = new CountDownLatch(1);

    int r = 4;
    String[] p = msg.split("\\s+");
    if (p.length >= 2) {
        try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
    }
    final int radius = Math.max(1, Math.min(12, r));

    mc.execute(() -> {
        try {
            if (mc.player == null || mc.level == null) {
                res[0] = "ERR:no_player";
                return;
            }

            BlockPos origin = mc.player.blockPosition();

            int water = 0;
            int lava = 0;
            int stone = 0;
            int deepslate = 0;
            int netherrack = 0;

            int totalLight = 0;
            int samples = 0;

            for (int dx = -radius; dx <= radius; dx++) {
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dz = -radius; dz <= radius; dz++) {

                        BlockPos pos = origin.offset(dx, dy, dz);
                        BlockState st = mc.level.getBlockState(pos);
                        Block b = st.getBlock();

                        ResourceLocation id = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(b);
                        if (id == null) continue;

                        String sid = id.toString();

                        if (sid.equals("minecraft:water")) water++;
                        else if (sid.equals("minecraft:lava")) lava++;
                        else if (
                        sid.equals("minecraft:deepslate") ||
                        sid.equals("minecraft:cobbled_deepslate") ||
                        sid.equals("minecraft:infested_deepslate")
                        ) deepslate++;
                        else if (sid.equals("minecraft:netherrack")) netherrack++;
                        else if (
                        sid.equals("minecraft:stone") ||
                        sid.equals("minecraft:cobblestone") ||
                        sid.equals("minecraft:andesite") ||
                        sid.equals("minecraft:diorite") ||
                        sid.equals("minecraft:granite") ||
                        sid.equals("minecraft:tuff")
                        ) stone++;

                        int light = mc.level.getMaxLocalRawBrightness(pos);
                        totalLight += light;
                        samples++;
                    }
                }
            }

            int avgLight = (samples > 0) ? (totalLight / samples) : 0;

            res[0] = String.format(Locale.ROOT,
                    "OK:env water=%d lava=%d stone=%d deepslate=%d netherrack=%d light=%d",
                    water, lava, stone, deepslate, netherrack, avgLight
            );

        } finally {
            latch.countDown();
        }
    });

    try {
        if (!latch.await(1200, TimeUnit.MILLISECONDS)) return "ERR:timeout";
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return "ERR:interrupted";
    }

    return res[0];
}
    private static int getMaxAge(IntegerProperty ageProp) {
        int max = 0;
        for (Integer v : ageProp.getPossibleValues()) {
            if (v != null && v > max) max = v;
        }
        return max;
    }
    // =========================
    // Chest session (client-side)
    // =========================
    private static volatile boolean chestOpen = false;
    private static volatile int chestContainerSlots = 0; // container slots only (no player inv)
    private static final double REACH_DIST = 5.75;

    // =========================
    // Key-hold states (client-side)
    // =========================
    private static volatile boolean holdUse = false;
    private static volatile boolean holdAttack = false;

    public static void start(int port) {
        if (started) return;
        started = true;

        Thread t = new Thread(() -> run(port), "EllyBridge-ClientTCP");
        t.setDaemon(true);
        t.start();

        System.out.println("[EllyBridge] Listening on 127.0.0.1:" + port);
    }

    private static void run(int port) {
        try (ServerSocket server = new ServerSocket()) {
            server.bind(new InetSocketAddress("127.0.0.1", port));

            while (true) {
                try (Socket s = server.accept();
                     BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                     BufferedWriter out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8))) {

                    s.setTcpNoDelay(true);
                    System.out.println("[EllyBridge] Node connected: " + s.getRemoteSocketAddress());

                    Thread telemetry = new Thread(() -> telemetryLoop(s, out), "EllyBridge-Telemetry");
                    telemetry.setDaemon(true);
                    telemetry.start();

                    Thread keyHold = new Thread(() -> keyHoldLoop(s), "EllyBridge-KeyHold");
                    keyHold.setDaemon(true);
                    keyHold.start();

                    String line;
                    while ((line = in.readLine()) != null) {
                        String msg = line.trim();
                        if (msg.isEmpty()) continue;

                        String resp = handle(msg);

                        if (resp != null) {
                            synchronized (OUT_LOCK) {
                                out.write(resp);
                                out.write("\n");
                                out.flush();
                            }
                        }
                    }

                    // Ensure keys released on disconnect
                    holdUse = false;
                    holdAttack = false;
                    Minecraft mc = Minecraft.getInstance();
                    mc.execute(() -> {
                        try {
                            if (mc.options != null && mc.options.keyUse != null) mc.options.keyUse.setDown(false);
                            if (mc.options != null && mc.options.keyAttack != null) mc.options.keyAttack.setDown(false);
                        } catch (Throwable ignored) {}
                    });

                    System.out.println("[EllyBridge] Node disconnected");
                } catch (Exception e) {
                    System.out.println("[EllyBridge] Client error: " + e);
                }
            }
        } catch (Exception e) {
            System.out.println("[EllyBridge] TCP crashed: " + e);
        }
    }

    // =========================
    // Telemetry
    // =========================
    private static void telemetryLoop(Socket s, BufferedWriter out) {
        try {
            while (!s.isClosed()) {
                if (telemetryEnabled) {
                    String tel = buildTelemetry();
                    if (tel != null) {
                        synchronized (OUT_LOCK) {
                            out.write(tel);
                            out.write("\n");
                            out.flush();
                        }
                    }
                }
                Thread.sleep(1000);
            }
        } catch (Exception ignored) {}
    }

    // keep key holds applied while requested
    private static void keyHoldLoop(Socket s) {
        try {
            while (!s.isClosed()) {
                Minecraft mc = Minecraft.getInstance();
                boolean use = holdUse;
                boolean atk = holdAttack;

                mc.execute(() -> {
                    try {
                        if (mc.options != null && mc.options.keyUse != null) mc.options.keyUse.setDown(use);
                        if (mc.options != null && mc.options.keyAttack != null) mc.options.keyAttack.setDown(atk);
                    } catch (Throwable ignored) {}
                });

                Thread.sleep(50);
            }
        } catch (Exception ignored) {}
    }

    private static String buildTelemetry() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return null;

        return String.format(Locale.ROOT,
                "TEL:pos=%.1f,%.1f,%.1f dim=%s hp=%.1f food=%d",
                mc.player.getX(),
                mc.player.getY(),
                mc.player.getZ(),
                mc.level.dimension().location().toString(),
                mc.player.getHealth(),
                mc.player.getFoodData().getFoodLevel()
        );
    }

    // =========================
    // Command handler
    // =========================
    private static String handle(String msg) {


        // --- control spam ---
        if (msg.equalsIgnoreCase("TEL:OFF")) {
            telemetryEnabled = false;
            return "OK:tel_off";
        }
        if (msg.equalsIgnoreCase("TEL:ON")) {
            telemetryEnabled = true;
            return "OK:tel_on";
        }

        // one-shot telemetry regardless of TEL:ON/OFF
        if (msg.equalsIgnoreCase("TEL:ONCE")) {
            String tel = buildTelemetry();
            return (tel != null) ? tel : "ERR:no_player";
        }

        // --- ping ---
        if (msg.equalsIgnoreCase("PING?")) return "PONG";

        // --- position ---
        if (msg.equalsIgnoreCase("ELLY:POS?")) {
            return buildPosLine();
        }
        if (startsWithIgnoreCase(msg, "PLAYER:POS")) {
            String name = msg.substring("PLAYER:POS".length()).trim();
            if (name.isEmpty()) return "ERR:usage PLAYER:POS <name>";
            return handlePlayerPos(name);
        }

        // --- inventory snapshot ---
        if (msg.equalsIgnoreCase("INV?")) {
            return buildInventoryServerStyle();
        }
        //respawn
        if (msg.equalsIgnoreCase("RESPAWN")) {
            return handleRespawn();
        }
        // --- chest open/list/take/put/close ---
        if (startsWithIgnoreCase(msg, "CHEST:OPEN")) {
            String[] p = msg.split("\\s+");
            if (p.length != 4) return "ERR:usage CHEST:OPEN <x> <y> <z>";

            int x, y, z;
            try {
                x = Integer.parseInt(p[1]);
                y = Integer.parseInt(p[2]);
                z = Integer.parseInt(p[3]);
            } catch (Exception e) {
                return "ERR:bad_coords";
            }

            return handleChestOpen(x, y, z);
        }

        if (msg.equalsIgnoreCase("CHEST:LIST")) {
            return handleChestList();
        }

        if (startsWithIgnoreCase(msg, "CHEST:TAKE")) {
            String[] p = msg.split("\\s+");
            if (p.length != 3) return "ERR:usage CHEST:TAKE <slot> <qty|all>";

            int slot;
            try { slot = Integer.parseInt(p[1]); }
            catch (Exception e) { return "ERR:bad_slot"; }

            int qty = parseQty(p[2]);
            if (qty <= 0) return "ERR:bad_qty";

            return handleChestTake(slot, qty);
        }

        if (startsWithIgnoreCase(msg, "CHEST:PUT ")) {
            String[] p = msg.split("\\s+");
            if (p.length != 3) return "ERR:usage CHEST:PUT <invSlot> <qty|all>";

            int invSlot;
            try { invSlot = Integer.parseInt(p[1]); }
            catch (Exception e) { return "ERR:bad_slot"; }

            int qty = parseQty(p[2]);
            if (qty <= 0) return "ERR:bad_qty";

            return handleChestPut(invSlot, qty);
        }

        // put by item id (or "all")
        if (startsWithIgnoreCase(msg, "CHEST:PUTMATCH")) {
            String[] p = msg.split("\\s+");
            if (p.length != 3) return "ERR:usage CHEST:PUTMATCH <item_id|all> <qty|all>";
            String what = p[1].trim();
            int qty = parseQty(p[2].trim());
            if (qty <= 0) return "ERR:bad_qty";
            return handleChestPutMatch(what, qty);
        }

        if (msg.equalsIgnoreCase("CHEST:CLOSE")) {
            return handleChestClose();
        }

        // --- count item ---
        if (startsWithIgnoreCase(msg, "HAS:")) {
            String q = msg.substring(4).trim();
            if (q.isEmpty()) return "ERR:usage HAS:<item_id>";
            return handleHas(q);
        }

        // --- drop item ---
        if (startsWithIgnoreCase(msg, "DROP:")) {
            String rest = msg.substring(5).trim();
            if (rest.isEmpty()) return "ERR:usage DROP:<item_id> <qty|all>";
            String[] p = rest.split("\\s+");
            if (p.length != 2) return "ERR:usage DROP:<item_id> <qty|all>";

            String itemRaw = p[0].trim();
            int qty = parseQty(p[1].trim());
            if (qty <= 0) return "ERR:bad_qty";

            return handleDropServer(itemRaw, qty);
        }

        // --- say/chat ---
        if (startsWithIgnoreCase(msg, "ELLY:SAY")) {
            String text = msg.substring("ELLY:SAY".length()).trim();
            if (text.isEmpty()) return "ERR:usage ELLY:SAY <text>";
            sendChat(text);
            return "OK:say";
        }

        if (startsWithIgnoreCase(msg, "CHAT:")) {
            String text = msg.substring(5).trim();
            if (text.isEmpty()) return "ERR:usage CHAT:<text>";
            sendChat(text);
            return "OK:chat";
        }

        // --- baritone controls ---
        if (startsWithIgnoreCase(msg, "ELLY:GOTO")) {
            String[] p = msg.split("\\s+");
            if (p.length != 4) return "ERR:usage ELLY:GOTO <x> <y> <z>";

            int x, y, z;
            try {
                x = Integer.parseInt(p[1]);
                y = Integer.parseInt(p[2]);
                z = Integer.parseInt(p[3]);
            } catch (Exception e) {
                return "ERR:bad_coords";
            }

            boolean ok = baritoneGoto(x, y, z);
            if (!ok) {
                sendChat("#goto " + x + " " + y + " " + z);
                return "OK:goto_fallback";
            }
            return "OK:goto";
        }

        if (msg.equalsIgnoreCase("ELLY:STOP")) {
            boolean ok = baritoneCancel();
            if (!ok) {
                sendChat("#stop");
                return "OK:stop_fallback";
            }
            return "OK:stop";
        }

        if (startsWithIgnoreCase(msg, "ELLY:FOLLOW")) {
            String name = msg.substring("ELLY:FOLLOW".length()).trim();
            if (name.isEmpty()) return "ERR:usage ELLY:FOLLOW <playerName>";

            boolean ok = baritoneFollowPlayer(name);
            if (!ok) {
                sendChat("#follow player " + name);
                return "OK:follow_fallback";
            }
            return "OK:follow " + name;
        }

        // --- select hotbar ---
        if (startsWithIgnoreCase(msg, "INV:SELECT")) {
            String[] p = msg.split("\\s+");
            if (p.length != 2) return "ERR:usage INV:SELECT <slot0-8>";
            int slot;
            try { slot = Integer.parseInt(p[1]); }
            catch (Exception e) { return "ERR:bad_slot"; }
            return handleInvSelect(slot);
        }

        // --- swap invSlot -> hotbarSlot ---
        if (startsWithIgnoreCase(msg, "INV:SWAP")) {
            String[] p = msg.split("\\s+");
            if (p.length != 3) return "ERR:usage INV:SWAP <invSlot0-35> <hotbarSlot0-8>";
            int invSlot, hbSlot;
            try { invSlot = Integer.parseInt(p[1]); hbSlot = Integer.parseInt(p[2]); }
            catch (Exception e) { return "ERR:bad_slot"; }
            return handleInvSwap(invSlot, hbSlot);
        }

        if (msg.equalsIgnoreCase("INV:EQUIPARMORBEST")) {
            return handleEquipArmorBest();
        }

        // --- equip best ---
        if (startsWithIgnoreCase(msg, "INV:EQUIPBEST")) {
            String kind = msg.substring("INV:EQUIPBEST".length()).trim().toLowerCase(Locale.ROOT);
            if (kind.isEmpty())
                return "ERR:usage INV:EQUIPBEST <axe|pickaxe|shovel|hoe|sword|food|block:minecraft:id>";
            return handleEquipBest(kind);
        }

        // --- simple controls/senses ---
        if (msg.equalsIgnoreCase("ELLY:ATTACK")) return handleAttack();
        if (msg.equalsIgnoreCase("ELLY:USE")) return handleUse();
        if (msg.equalsIgnoreCase("SENSE:HUNGER?")) return handleHunger();
        if (msg.equalsIgnoreCase("SENSE:WEATHER?")) return handleWeather();
        if (msg.equalsIgnoreCase("SENSE:TIME?")) return handleTime();
        if (msg.equalsIgnoreCase("SENSE:HOSTILES?")) return handleHostiles();
        if (startsWithIgnoreCase(msg, "SENSE:HOSTILES_DETAIL?")) return handleHostilesDetail(msg);
        if (startsWithIgnoreCase(msg, "SENSE:PASSIVES_DETAIL?")) return handlePassivesDetail(msg);
        if (msg.equalsIgnoreCase("SENSE:BIOME?")) return handleBiome();
        if (startsWithIgnoreCase(msg, "SENSE:CHESTS?")) return handleSenseChests(msg);
        if (startsWithIgnoreCase(msg, "SENSE:CROPS?")) return handleSenseCrops(msg);
        if (startsWithIgnoreCase(msg, "SENSE:ENV")) return handleSenseEnv(msg);
        if (startsWithIgnoreCase(msg, "CROP:STATUS")) return handleCropStatus(msg);
        if (startsWithIgnoreCase(msg, "CROP:HARVEST")) return handleCropHarvest(msg);
        if (startsWithIgnoreCase(msg, "CROP:PLANT")) return handleCropPlant(msg);
        // =========================
        // use key hold (for eating / sustained use)
        // =========================
        if (msg.equalsIgnoreCase("USE:START")) {
            holdUse = true;
            return "OK:use_hold_on";
        }
        if (msg.equalsIgnoreCase("USE:STOP")) {
            holdUse = false;
            return "OK:use_hold_off";
        }
        if (msg.equalsIgnoreCase("ATTACK:START")) {
            holdAttack = true;
            return "OK:attack_hold_on";
        }
        if (msg.equalsIgnoreCase("ATTACK:STOP")) {
            holdAttack = false;
            return "OK:attack_hold_off";
        }

        if (msg.equalsIgnoreCase("BOWSHOT")) {

            Minecraft mc = Minecraft.getInstance();

            if (mc.player == null || mc.gameMode == null) {
                return "ERR:no_player";
            }

            mc.execute(() -> {
                try {
                    // avvia davvero l'uso dell'item in mano
                    mc.gameMode.useItem(mc.player, InteractionHand.MAIN_HAND);

                    new Thread(() -> {
                        try {
                            Thread.sleep(900);

                            mc.execute(() -> {
                                try {
                                    mc.player.releaseUsingItem();
                                } catch (Exception ignored) {}
                            });

                        } catch (Exception ignored) {}
                    }, "EllyBridge-BowRelease").start();

                } catch (Exception ignored) {}
            });

            return "OK:bowshot";
        }

        if (msg.equalsIgnoreCase("MELEE:HIT")) {

            Minecraft mc = Minecraft.getInstance();

            if (mc.player == null || mc.gameMode == null) {
                return "ERR:no_player";
            }

            mc.execute(() -> {
                try {
                    Entity hit = mc.crosshairPickEntity;

                    if (hit != null && hit.isAlive()) {
                        mc.gameMode.attack(mc.player, hit);
                        mc.player.swing(InteractionHand.MAIN_HAND);
                    } else {
                        mc.player.swing(InteractionHand.MAIN_HAND);
                    }
                } catch (Exception ignored) {}
            });

            return "OK:melee_hit";
        }
        // eat helper (select best edible -> hold use for N ms -> release)
        // Usage: EAT:BEST <ms>
        if (startsWithIgnoreCase(msg, "EAT:BEST")) {
            String[] p = msg.split("\\s+");
            int ms = 1400;
            if (p.length == 2) {
                try { ms = Integer.parseInt(p[1]); } catch (Exception ignored) {}
            }
            ms = Math.max(200, Math.min(6000, ms));
            return handleEatBest(ms);
        }

        // =========================
        // look controls
        // =========================
        // LOOK:AT <x> <y> <z>
        if (startsWithIgnoreCase(msg, "LOOK:AT")) {
            String[] p = msg.split("\\s+");
            if (p.length != 4) return "ERR:usage LOOK:AT <x> <y> <z>";
            double x, y, z;
            try {
                x = Double.parseDouble(p[1]);
                y = Double.parseDouble(p[2]);
                z = Double.parseDouble(p[3]);
            } catch (Exception e) {
                return "ERR:bad_coords";
            }
            return handleLookAt(x, y, z);
        }

        // LOOK:YAWPITCH <yaw> <pitch>
        if (startsWithIgnoreCase(msg, "LOOK:YAWPITCH")) {
            String[] p = msg.split("\\s+");
            if (p.length != 3) return "ERR:usage LOOK:YAWPITCH <yaw> <pitch>";
            float yaw, pitch;
            try {
                yaw = Float.parseFloat(p[1]);
                pitch = Float.parseFloat(p[2]);
            } catch (Exception e) {
                return "ERR:bad_angles";
            }
            return handleLookYawPitch(yaw, pitch);
        }

        // LOOK:PLAYER <name>
        if (startsWithIgnoreCase(msg, "LOOK:PLAYER")) {
            String name = msg.substring("LOOK:PLAYER".length()).trim();
            if (name.isEmpty()) return "ERR:usage LOOK:PLAYER <name>";
            return handleLookPlayer(name);
        }

        // =========================
        // bed helpers
        // =========================
        // BED:FIND <radius>
        if (startsWithIgnoreCase(msg, "BED:FIND")) {
            String[] p = msg.split("\\s+");
            int r = 10;
            if (p.length == 2) {
                try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
            }
            r = Math.max(2, Math.min(64, r));
            return handleBedFind(r);
        }

        // BED:SLEEP <x> <y> <z>
        if (startsWithIgnoreCase(msg, "BED:SLEEP")) {
            String[] p = msg.split("\\s+");
            if (p.length != 4) return "ERR:usage BED:SLEEP <x> <y> <z>";
            int x, y, z;
            try {
                x = Integer.parseInt(p[1]);
                y = Integer.parseInt(p[2]);
                z = Integer.parseInt(p[3]);
            } catch (Exception e) {
                return "ERR:bad_coords";
            }
            return handleBedSleep(x, y, z);
        }

        // BED:SLEEP_AUTO <radius>
        if (startsWithIgnoreCase(msg, "BED:SLEEP_AUTO")) {
            String[] p = msg.split("\\s+");
            int r = 10;
            if (p.length == 2) {
                try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
            }
            r = Math.max(2, Math.min(64, r));
            return handleBedSleepAuto(r);
        }

        // SENSE:ME_SLEEPING?
        if (msg.equalsIgnoreCase("SENSE:ME_SLEEPING?")) {
            return handleMeSleeping();
        }

        // SENSE:PLAYER_SLEEP? <name>
        if (startsWithIgnoreCase(msg, "SENSE:PLAYER_SLEEP?")) {
            String name = msg.substring("SENSE:PLAYER_SLEEP?".length()).trim();
            if (name.isEmpty()) return "ERR:usage SENSE:PLAYER_SLEEP? <name>";
            return handlePlayerSleep(name);
        }

        return "ERR:unknown_cmd";
    }

    // =========================
    // INV helpers
    // =========================
    private static String handleRespawn() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc == null) {
                    res[0] = "ERR:no_mc";
                    return;
                }

                if (mc.player != null && mc.player.isAlive()) {
                    res[0] = "OK:respawn_skip alive";
                    return;
                }

                if (mc.screen == null) {
                    res[0] = "ERR:no_death_screen";
                    return;
                }

                try {
                    mc.player.respawn();
                    res[0] = "OK:respawn";
                } catch (Throwable t1) {
                    try {
                        Method m = mc.getClass().getMethod("respawn");
                        m.invoke(mc);
                        res[0] = "OK:respawn";
                    } catch (Throwable t2) {
                        res[0] = "ERR:respawn_failed";
                    }
                }
            } finally {
                latch.countDown();
            }
        });

        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS)) return "ERR:timeout";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "ERR:interrupted";
        }

        return res[0];
    }

    private static String handleInvSelect(int slot0to8) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                if (slot0to8 < 0 || slot0to8 > 8) { res[0] = "ERR:bad_slot"; return; }
                mc.player.getInventory().selected = slot0to8;
                res[0] = "OK:inv_select " + slot0to8;
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleInvSwap(int invSlot0to35, int hotbarSlot0to8) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }
                if (invSlot0to35 < 0 || invSlot0to35 > 35) { res[0] = "ERR:bad_slot"; return; }
                if (hotbarSlot0to8 < 0 || hotbarSlot0to8 > 8) { res[0] = "ERR:bad_slot"; return; }

                AbstractContainerMenu menu = mc.player.inventoryMenu;
                int menuInvSlot = mapPlayerInvSlotToInventoryMenuSlot(invSlot0to35);
                if (menuInvSlot < 0) { res[0] = "ERR:bad_slot"; return; }

                mc.gameMode.handleInventoryMouseClick(menu.containerId, menuInvSlot, hotbarSlot0to8, ClickType.SWAP, mc.player);
                res[0] = "OK:inv_swap inv=" + invSlot0to35 + " hb=" + hotbarSlot0to8;
            } catch (Exception e) {
                res[0] = "ERR:swap_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(900, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    // =========================
    // ATTACK / USE
    // =========================
    private static String handleAttack() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                if (mc.options == null || mc.options.keyAttack == null) { res[0] = "ERR:no_keymap"; return; }

                mc.options.keyAttack.setDown(true);
                mc.options.keyAttack.setDown(false);
                mc.player.swing(InteractionHand.MAIN_HAND);
                res[0] = "OK:attack";
            } catch (Exception e) {
                res[0] = "ERR:attack_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleUse() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                if (mc.options == null || mc.options.keyUse == null) { res[0] = "ERR:no_keymap"; return; }

                mc.options.keyUse.setDown(true);
                mc.options.keyUse.setDown(false);
                res[0] = "OK:use";
            } catch (Exception e) {
                res[0] = "ERR:use_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    // select best edible and hold-use for ms (for auto-eat)
    private static String handleEatBest(int ms) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }

                var inv = mc.player.getInventory();
                int bestSlot = -1;
                int bestScore = -1;

                for (int i = 0; i <= 35 && i < inv.items.size(); i++) {
                    ItemStack st = inv.items.get(i);
                    if (st.isEmpty()) continue;
                    if (!st.isEdible()) continue;

                    int score = 100 + st.getCount();
                    if (i >= 0 && i <= 8) score += 50; // prefer already in hotbar
                    if (score > bestScore) { bestScore = score; bestSlot = i; }
                }

                if (bestSlot < 0) { res[0] = "ERR:no_food"; return; }

                int hb = inv.selected;
                if (hb < 0 || hb > 8) hb = 0;

                if (bestSlot != hb) {
                    AbstractContainerMenu menu = mc.player.inventoryMenu;
                    int menuInvSlot = mapPlayerInvSlotToInventoryMenuSlot(bestSlot);
                    mc.gameMode.handleInventoryMouseClick(menu.containerId, menuInvSlot, hb, ClickType.SWAP, mc.player);
                    inv.selected = hb;
                }

                holdUse = true;
                res[0] = "OK:eat_hold ms=" + ms + " hb=" + hb;
            } catch (Exception e) {
                res[0] = "ERR:eatbest_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1200, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        new Thread(() -> {
            try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
            holdUse = false;
        }, "EllyBridge-EatRelease").start();

        return res[0];
    }

    // =========================
    // LOOK
    // =========================
    private static String handleLookYawPitch(float yaw, float pitch) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        final float yawF = yaw;
        final float pitchF = Mth.clamp(pitch, -90.0f, 90.0f);

        mc.execute(() -> {
            try {
                if (mc.player == null) {
                    res[0] = "ERR:no_player";
                    return;
                }

                mc.player.setYRot(yawF);
                mc.player.setXRot(pitchF);

                mc.player.yHeadRot = yawF;
                mc.player.yBodyRot = yawF;

                res[0] = String.format(Locale.ROOT, "OK:look yaw=%.1f pitch=%.1f", yawF, pitchF);
            } catch (Exception e) {
                res[0] = "ERR:look_failed";
            } finally {
                latch.countDown();
            }
        });

        try {
            if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "ERR:interrupted";
        }
        return res[0];
    }

    private static String handleLookAt(double x, double y, double z) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                Vec3 eye = mc.player.getEyePosition();
                Vec3 tgt = new Vec3(x, y, z);
                Vec3 d = tgt.subtract(eye);

                double dx = d.x;
                double dy = d.y;
                double dz = d.z;

                double distXZ = Math.sqrt(dx * dx + dz * dz);
                float yaw = (float)(Mth.wrapDegrees(Math.toDegrees(Math.atan2(dz, dx)) - 90.0));
                float pitch = (float)(-Math.toDegrees(Math.atan2(dy, distXZ)));

                pitch = Mth.clamp(pitch, -90.0f, 90.0f);

                mc.player.setYRot(yaw);
                mc.player.setXRot(pitch);
                mc.player.setYHeadRot(yaw);

                res[0] = String.format(Locale.ROOT, "OK:look_at yaw=%.1f pitch=%.1f", yaw, pitch);
            } catch (Exception e) {
                res[0] = "ERR:look_at_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleLookPlayer(String name) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }

                Entity target = mc.level.players().stream()
                        .filter(p -> p.getGameProfile().getName().equalsIgnoreCase(name))
                        .findFirst().orElse(null);

                if (target == null) { res[0] = "ERR:player_not_found"; return; }

                Vec3 p = target.position().add(0, target.getBbHeight() * 0.85, 0);
                Vec3 eye = mc.player.getEyePosition();
                Vec3 d = p.subtract(eye);

                double dx = d.x;
                double dy = d.y;
                double dz = d.z;
                double distXZ = Math.sqrt(dx * dx + dz * dz);

                float yaw = (float)(Mth.wrapDegrees(Math.toDegrees(Math.atan2(dz, dx)) - 90.0));
                float pitch = (float)(-Math.toDegrees(Math.atan2(dy, distXZ)));
                pitch = Mth.clamp(pitch, -90.0f, 90.0f);

                mc.player.setYRot(yaw);
                mc.player.setXRot(pitch);
                mc.player.setYHeadRot(yaw);

                res[0] = "OK:look_player " + name;
            } catch (Exception e) {
                res[0] = "ERR:look_player_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(500, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    // =========================
    // BED
    // =========================
    private static final BooleanProperty BED_OCCUPIED = BedBlock.OCCUPIED;

    private static String handleBedFind(int radius) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }

                BlockPos origin = mc.player.blockPosition();
                int r = radius;

                List<BedHit> beds = new ArrayList<>();

                for (int dx = -r; dx <= r; dx++) {
                    for (int dy = -2; dy <= 2; dy++) {
                        for (int dz = -r; dz <= r; dz++) {
                            BlockPos p = origin.offset(dx, dy, dz);
                            BlockState st = mc.level.getBlockState(p);
                            Block b = st.getBlock();
                            if (!(b instanceof BedBlock)) continue;

                            BlockPos bedPos = p;
                            try {
                                if (st.hasProperty(BedBlock.PART) && st.getValue(BedBlock.PART) == BedPart.FOOT) {
                                    Direction facing = st.getValue(BedBlock.FACING);
                                    bedPos = p.relative(facing);
                                    st = mc.level.getBlockState(bedPos);
                                }
                            } catch (Throwable ignored) {}

                            boolean occupied = false;
                            try { occupied = st.hasProperty(BED_OCCUPIED) && st.getValue(BED_OCCUPIED); }
                            catch (Throwable ignored) {}

                            double dist2 = bedPos.distToCenterSqr(mc.player.position());
                            beds.add(new BedHit(bedPos, occupied, dist2));
                        }
                    }
                }

                if (beds.isEmpty()) { res[0] = "OK:bed_find none"; return; }

                beds.sort(Comparator.comparingDouble(a -> a.dist2));

                BedHit nearest = beds.get(0);
                BedHit nearestFree = beds.stream().filter(bh -> !bh.occupied).findFirst().orElse(null);

                if (nearestFree == null) {
                    res[0] = String.format(Locale.ROOT,
                            "OK:bed_find none_free nearest=%d,%d,%d occupied=true",
                            nearest.pos.getX(), nearest.pos.getY(), nearest.pos.getZ()
                    );
                    return;
                }

                res[0] = String.format(Locale.ROOT,
                        "OK:bed_find free=%d,%d,%d occupied=false nearest=%d,%d,%d nearestOcc=%s",
                        nearestFree.pos.getX(), nearestFree.pos.getY(), nearestFree.pos.getZ(),
                        nearest.pos.getX(), nearest.pos.getY(), nearest.pos.getZ(),
                        nearest.occupied ? "true" : "false"
                );

            } catch (Exception e) {
                res[0] = "ERR:bed_find_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1600, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleBedSleep(int x, int y, int z) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }

                BlockPos pos = new BlockPos(x, y, z);

                Vec3 eye = new Vec3(mc.player.getX(), mc.player.getY() + mc.player.getEyeHeight(), mc.player.getZ());
                Vec3 hit = Vec3.atCenterOf(pos);
                if (eye.distanceTo(hit) > REACH_DIST) { res[0] = "ERR:too_far"; return; }

                BlockState st = mc.level.getBlockState(pos);
                if (!(st.getBlock() instanceof BedBlock)) { res[0] = "ERR:not_a_bed"; return; }

                try {
                    if (st.hasProperty(BedBlock.PART) && st.getValue(BedBlock.PART) == BedPart.FOOT) {
                        Direction facing = st.getValue(BedBlock.FACING);
                        pos = pos.relative(facing);
                        st = mc.level.getBlockState(pos);
                    }
                } catch (Throwable ignored) {}

                boolean occupied = false;
                try { occupied = st.hasProperty(BED_OCCUPIED) && st.getValue(BED_OCCUPIED); }
                catch (Throwable ignored) {}

                if (occupied) { res[0] = "ERR:bed_occupied"; return; }

                Vec3 hitVec = new Vec3(pos.getX() + 0.5, pos.getY() + 0.56, pos.getZ() + 0.5);
                BlockHitResult bhr = new BlockHitResult(hitVec, Direction.UP, pos, false);
                var result = mc.gameMode.useItemOn(mc.player, InteractionHand.MAIN_HAND, bhr);

                res[0] = "OK:bed_sleep_sent result=" + result;
            } catch (Exception e) {
                res[0] = "ERR:bed_sleep_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(900, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleBedSleepAuto(int radius) {
        String find = handleBedFind(radius);
        if (!find.startsWith("OK:bed_find")) return find;
        if (find.contains(" none")) return "ERR:no_bed";
        if (find.contains(" none_free")) return "ERR:no_free_bed";

        int idx = find.indexOf("free=");
        if (idx < 0) return "ERR:parse_find";
        String rest = find.substring(idx + 5).trim();
        String[] parts = rest.split("\\s+");
        if (parts.length < 1) return "ERR:parse_find";
        String[] xyz = parts[0].split(",");
        if (xyz.length != 3) return "ERR:parse_find";
        int bx, by, bz;
        try {
            bx = Integer.parseInt(xyz[0]);
            by = Integer.parseInt(xyz[1]);
            bz = Integer.parseInt(xyz[2]);
        } catch (Exception e) {
            return "ERR:parse_find";
        }
        final BlockPos bedPos = new BlockPos(bx, by, bz);

        // compute a safe adjacent stand position (cardinals)
        Minecraft mc = Minecraft.getInstance();
        final BlockPos[] stand = new BlockPos[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.level == null) return;

                BlockPos best = null;
                double bestDist2 = Double.MAX_VALUE;

                for (Direction dir : new Direction[]{Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST}) {
                    BlockPos p = bedPos.relative(dir);
                    BlockState st = mc.level.getBlockState(p);
                    BlockState below = mc.level.getBlockState(p.below());

                    boolean space = st.isAir();
                    boolean ground = !below.isAir();

                    if (!space || !ground) continue;

                    double d2 = p.distToCenterSqr(mc.player.position());
                    if (d2 < bestDist2) { bestDist2 = d2; best = p; }
                }

                stand[0] = (best != null) ? best : bedPos.relative(Direction.SOUTH);
            } finally {
                latch.countDown();
            }
        });

        try { latch.await(500, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}

        if (stand[0] == null) return "ERR:no_level";

        // send baritone goto (stand pos)
        // Try to prevent Baritone from breaking/placing blocks during this short approach (protect the bed).
        // Done via chat so it works even when Baritone reflection calls fail.
        sendChat("#set allowBreak false");
        sendChat("#set allowPlace false");

        boolean ok = baritoneGoto(stand[0].getX(), stand[0].getY(), stand[0].getZ());
        if (!ok) sendChat("#goto " + stand[0].getX() + " " + stand[0].getY() + " " + stand[0].getZ());

        long deadline = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < deadline) {
            final double[] d = new double[1];
            CountDownLatch l2 = new CountDownLatch(1);

            mc.execute(() -> {
                try {
                    if (mc.player == null) { d[0] = 9999; return; }
                    Vec3 pos = mc.player.position();
                    Vec3 tgt = Vec3.atCenterOf(stand[0]);
                    d[0] = pos.distanceTo(tgt);
                } finally { l2.countDown(); }
            });

            try { l2.await(250, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}

            if (d[0] <= 1.25) {
                // stop pathing so it doesn't keep steering while we interact
                baritoneCancel();
                sendChat("#stop");

                // now interact with bed
                String clickRes = handleBedSleep(bedPos.getX(), bedPos.getY(), bedPos.getZ());

                // restore defaults
                sendChat("#set allowBreak true");
                sendChat("#set allowPlace true");

                return clickRes;
            }

            try { Thread.sleep(80); } catch (InterruptedException ignored) {}
        }

        // restore defaults on timeout as well
        sendChat("#set allowBreak true");
        sendChat("#set allowPlace true");
        return "ERR:bed_sleep_auto_timeout";
    }

    private static String handleMeSleeping() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                boolean sleeping = false;
                try { sleeping = mc.player.isSleeping(); } catch (Throwable ignored) {}
                res[0] = "OK:me_sleeping=" + (sleeping ? "true" : "false");
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(400, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handlePlayerSleep(String name) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.level == null) { res[0] = "ERR:no_level"; return; }

                var target = mc.level.players().stream()
                        .filter(p -> p.getGameProfile().getName().equalsIgnoreCase(name))
                        .findFirst().orElse(null);

                if (target == null) { res[0] = "ERR:player_not_found"; return; }

                boolean sleeping = false;
                try { sleeping = target.isSleeping(); } catch (Throwable ignored) {}
                res[0] = "OK:player_sleep name=" + name + " sleeping=" + (sleeping ? "true" : "false");
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(600, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static class BedHit {
        final BlockPos pos;
        final boolean occupied;
        final double dist2;
        BedHit(BlockPos pos, boolean occupied, double dist2) {
            this.pos = pos;
            this.occupied = occupied;
            this.dist2 = dist2;
        }
    }

    // =========================
    // SENSE:*
    // =========================
    private static String handleHunger() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                int food = mc.player.getFoodData().getFoodLevel();
                float sat = mc.player.getFoodData().getSaturationLevel();
                res[0] = String.format(Locale.ROOT, "OK:hunger food=%d sat=%.1f", food, sat);
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleWeather() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.level == null) { res[0] = "ERR:no_level"; return; }
                boolean thundering = mc.level.isThundering();
                boolean raining = mc.level.isRaining();
                String w = thundering ? "thunder" : (raining ? "rain" : "clear");
                res[0] = "OK:weather " + w;
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleTime() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.level == null) { res[0] = "ERR:no_level"; return; }
                long dayTime = mc.level.getDayTime();
                long gameTime = mc.level.getGameTime();
                res[0] = "OK:time dayTime=" + dayTime + " gameTime=" + gameTime;
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleHostiles() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }
                double r = 10.0;
                int count = 0;
                var aabb = mc.player.getBoundingBox().inflate(r, 4.0, r);
                for (var e : mc.level.getEntities(mc.player, aabb)) {
                    if (e instanceof Monster) count++;
                }
                res[0] = "OK:hostiles count=" + count;
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(450, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }
    private static String handleHostilesDetail(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        int r = 16;
        String[] p = msg.split("\\s+");
        if (p.length >= 2) {
            try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
        }
        final int radius = Math.max(2, Math.min(48, r));

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) { res[0] = "ERR:no_player"; return; }

                var aabb = mc.player.getBoundingBox().inflate(radius, 6.0, radius);
                List<Entity> found = new ArrayList<>();

                for (var e : mc.level.getEntities(mc.player, aabb)) {
                    if (!(e instanceof Monster)) continue;
                    if (!e.isAlive()) continue;
                    found.add(e);
                }

                if (found.isEmpty()) {
                    res[0] = "OK:hostiles_detail none";
                    return;
                }

                found.sort(Comparator.comparingDouble(e -> e.distanceTo(mc.player)));

                StringBuilder sb = new StringBuilder("OK:hostiles_detail ");
                boolean any = false;

                for (Entity e : found) {
                    ResourceLocation eid = net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType());
                    if (eid == null) continue;

                    double dist = e.distanceTo(mc.player);

                    if (any) sb.append(';');
                    any = true;

                    sb.append(eid.toString())
                            .append('@')
                            .append((int)Math.floor(e.getX())).append(',')
                            .append((int)Math.floor(e.getY())).append(',')
                            .append((int)Math.floor(e.getZ())).append(',')
                            .append(String.format(Locale.ROOT, "%.1f", dist));
                }

                if (!any) sb.append("none");
                res[0] = sb.toString();
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(700, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handlePassivesDetail(String msg) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        int r = 16;
        String[] p = msg.split("\\s+");
        if (p.length >= 2) {
            try { r = Integer.parseInt(p[1]); } catch (Exception ignored) {}
        }
        final int radius = Math.max(2, Math.min(48, r));

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) {
                    res[0] = "ERR:no_player";
                    return;
                }

                var aabb = mc.player.getBoundingBox().inflate(radius, 6.0, radius);
                List<Entity> found = new ArrayList<>();

                for (var e : mc.level.getEntities(mc.player, aabb)) {
                    if (!e.isAlive()) continue;

                    ResourceLocation id = net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType());
                    if (id == null) continue;

                    String sid = id.toString();

                    // 🎯 SOLO PASSIVI
                    if (!sid.equals("minecraft:pig") &&
                            !sid.equals("minecraft:cow") &&
                            !sid.equals("minecraft:rabbit") &&
                            !sid.equals("minecraft:chicken") &&
                            !sid.equals("minecraft:sheep")) {
                        continue;
                    }

                    found.add(e);
                }

                if (found.isEmpty()) {
                    res[0] = "OK:passives_detail none";
                    return;
                }

                found.sort(Comparator.comparingDouble(e -> e.distanceTo(mc.player)));

                StringBuilder sb = new StringBuilder("OK:passives_detail ");
                boolean any = false;

                for (Entity e : found) {
                    ResourceLocation eid = net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType());
                    if (eid == null) continue;

                    double dist = e.distanceTo(mc.player);

                    if (any) sb.append(';');
                    any = true;

                    sb.append(eid.toString())
                            .append('@')
                            .append((int)Math.floor(e.getX())).append(',')
                            .append((int)Math.floor(e.getY())).append(',')
                            .append((int)Math.floor(e.getZ())).append(',')
                            .append(String.format(Locale.ROOT, "%.1f", dist));
                }

                if (!any) sb.append("none");
                res[0] = sb.toString();

            } finally {
                latch.countDown();
            }
        });

        try { if (!latch.await(700, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleBiome() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.level == null || mc.player == null) { res[0] = "ERR:no_world"; return; }

                BlockPos pos = mc.player.blockPosition();
                var biomeHolder = mc.level.getBiome(pos);

                String biomeId = biomeHolder.unwrapKey()
                        .map(k -> k.location().toString())
                        .orElse("unknown");

                res[0] = "OK:biome " + biomeId;
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(450, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }
    // =========================
    // Equip best
    // =========================
    private static String handleEquipBest(String kind) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }

                var inv = mc.player.getInventory();
                BestPick best = findBest(inv, kind);
                if (best == null) { res[0] = "ERR:not_found"; return; }

                int targetHotbar = inv.selected;
                if (targetHotbar < 0 || targetHotbar > 8) targetHotbar = 0;

                int bestInvSlot = best.invSlot;

                if (bestInvSlot != targetHotbar) {
                    AbstractContainerMenu menu = mc.player.inventoryMenu;
                    int menuInvSlot = mapPlayerInvSlotToInventoryMenuSlot(bestInvSlot);
                    mc.gameMode.handleInventoryMouseClick(menu.containerId, menuInvSlot, targetHotbar, ClickType.SWAP, mc.player);
                }

                inv.selected = targetHotbar;
                res[0] = "OK:equipbest kind=" + kind + " item=" + best.itemId + " hb=" + targetHotbar;
            } catch (Exception e) {
                res[0] = "ERR:equipbest_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1200, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }
        return res[0];
    }

    private static String handleEquipArmorBest() {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) {
                    res[0] = "ERR:no_player";
                    return;
                }

                AbstractContainerMenu menu = mc.player.inventoryMenu;
                var inv = mc.player.getInventory();

                int equipped = 0;

                equipped += tryEquipBestArmorPiece(mc, menu, inv, "helmet", 5);
                equipped += tryEquipBestArmorPiece(mc, menu, inv, "chestplate", 6);
                equipped += tryEquipBestArmorPiece(mc, menu, inv, "leggings", 7);
                equipped += tryEquipBestArmorPiece(mc, menu, inv, "boots", 8);

                res[0] = "OK:equiparmor changed=" + equipped;
            } catch (Exception e) {
                res[0] = "ERR:equiparmor_failed";
            } finally {
                latch.countDown();
            }
        });

        try {
            if (!latch.await(1400, TimeUnit.MILLISECONDS)) return "ERR:timeout";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "ERR:interrupted";
        }

        return res[0];
    }

    private static int tryEquipBestArmorPiece(Minecraft mc, AbstractContainerMenu menu, net.minecraft.world.entity.player.Inventory inv, String piece, int armorMenuSlot) {
        int bestInvSlot = -1;
        int bestScore = -1;

        for (int invSlot = 0; invSlot <= 35 && invSlot < inv.items.size(); invSlot++) {
            ItemStack st = inv.items.get(invSlot);
            if (st.isEmpty()) continue;

            ResourceLocation id = safeItemKey(st.getItem());
            if (id == null) continue;

            String sid = id.toString().toLowerCase(Locale.ROOT);
            int score = armorScoreForPiece(sid, piece);
            if (score <= 0) continue;

            if (score > bestScore) {
                bestScore = score;
                bestInvSlot = invSlot;
            }
        }

        ItemStack equippedStack = menu.getSlot(armorMenuSlot).getItem();
        int equippedScore = 0;
        if (!equippedStack.isEmpty()) {
            ResourceLocation eqId = safeItemKey(equippedStack.getItem());
            if (eqId != null) {
                equippedScore = armorScoreForPiece(eqId.toString().toLowerCase(Locale.ROOT), piece);
            }
        }

        if (bestInvSlot < 0) return 0;
        if (bestScore <= equippedScore) return 0;

        int sourceMenuSlot = mapPlayerInvSlotToInventoryMenuSlot(bestInvSlot);
        if (sourceMenuSlot < 0) return 0;

        // pickup source
        mc.gameMode.handleInventoryMouseClick(menu.containerId, sourceMenuSlot, 0, ClickType.PICKUP, mc.player);

        // place onto armor slot / swap with old armor if present
        mc.gameMode.handleInventoryMouseClick(menu.containerId, armorMenuSlot, 0, ClickType.PICKUP, mc.player);

        // if cursor still holds old armor, place it back in source slot
        ItemStack carried = menu.getCarried();
        if (!carried.isEmpty()) {
            mc.gameMode.handleInventoryMouseClick(menu.containerId, sourceMenuSlot, 0, ClickType.PICKUP, mc.player);
        }

        return 1;
    }

    private static int armorScoreForPiece(String sid, String piece) {
        if (sid == null || piece == null) return 0;
        sid = sid.toLowerCase(Locale.ROOT);
        piece = piece.toLowerCase(Locale.ROOT);

        if (!sid.endsWith("_" + piece)) return 0;

        int tier = 0;

        if (sid.startsWith("minecraft:netherite_")) tier = 70;
        else if (sid.startsWith("minecraft:diamond_")) tier = 60;
        else if (sid.startsWith("minecraft:iron_")) tier = 50;
        else if (sid.startsWith("minecraft:chainmail_")) tier = 45;
        else if (sid.startsWith("minecraft:golden_")) tier = 35;
        else if (sid.startsWith("minecraft:leather_")) tier = 20;

        // piccolo bonus ai pezzi enchantati
        return tier;
    }

    private static class BestPick {
        int invSlot;
        String itemId;
        int score;
        BestPick(int invSlot, String itemId, int score){ this.invSlot=invSlot; this.itemId=itemId; this.score=score; }
    }

    private static BestPick findBest(net.minecraft.world.entity.player.Inventory inv, String kind) {
        String wantBlock = null;
        if (kind.startsWith("block:")) wantBlock = kind.substring("block:".length()).trim();

        BestPick best = null;

        for (int i = 0; i < inv.items.size() && i <= 35; i++) {
            ItemStack st = inv.items.get(i);
            if (st.isEmpty()) continue;

            ResourceLocation id = safeItemKey(st.getItem());
            if (id == null) continue;

            String sid = id.toString();
            int score = scoreItemForKind(st, sid, kind, wantBlock);
            if (score <= 0) continue;

            if (best == null || score > best.score) best = new BestPick(i, sid, score);
        }
        return best;
    }

    private static int scoreItemForKind(ItemStack st, String sid, String kind, String wantBlock) {
        if (wantBlock != null) {
            String w = wantBlock.contains(":") ? wantBlock : "minecraft:" + wantBlock;
            return sid.equalsIgnoreCase(w) ? 1000 + st.getCount() : 0;
        }

        if (kind.equals("food")) return st.isEdible() ? 500 + st.getCount() : 0;

        boolean okType = switch (kind) {
            case "axe" -> sid.endsWith("_axe");
            case "pickaxe" -> sid.endsWith("_pickaxe");
            case "shovel" -> sid.endsWith("_shovel");
            case "hoe" -> sid.endsWith("_hoe");
            case "sword" -> sid.endsWith("_sword");
            default -> false;
        };
        if (!okType) return 0;

        int tier = 0;
        if (sid.startsWith("minecraft:netherite_")) tier = 60;
        else if (sid.startsWith("minecraft:diamond_")) tier = 50;
        else if (sid.startsWith("minecraft:iron_")) tier = 40;
        else if (sid.startsWith("minecraft:stone_")) tier = 30;
        else if (sid.startsWith("minecraft:golden_")) tier = 25;
        else if (sid.startsWith("minecraft:wooden_")) tier = 20;

        return 100 + tier;
    }

    // =========================
    // POS
    // =========================
    private static String buildPosLine() {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null) {
                    res[0] = "ELLY:none";
                    return;
                }
                res[0] = String.format(Locale.ROOT,
                        "ELLY:pos=%.1f,%.1f,%.1f dim=%s",
                        mc.player.getX(),
                        mc.player.getY(),
                        mc.player.getZ(),
                        mc.level.dimension().location().toString()
                );
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(350, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }


    private static String handlePlayerPos(String name) {
        Minecraft mc = Minecraft.getInstance();
        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.level == null) {
                    res[0] = "ERR:no_level";
                    return;
                }

                var target = mc.level.players().stream()
                        .filter(p -> p.getGameProfile().getName().equalsIgnoreCase(name))
                        .findFirst()
                        .orElse(null);

                if (target == null) {
                    res[0] = "ERR:player_not_found";
                    return;
                }

                res[0] = String.format(
                        Locale.ROOT,
                        "OK:player_pos %s %.1f %.1f %.1f",
                        target.getGameProfile().getName(),
                        target.getX(),
                        target.getY(),
                        target.getZ()
                );
            } finally {
                latch.countDown();
            }
        });

        try {
            if (!latch.await(500, TimeUnit.MILLISECONDS)) return "ERR:timeout";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "ERR:interrupted";
        }

        return res[0];
    }
    // =========================
    // Inventory / Has
    // =========================
    private static String buildInventoryServerStyle() {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "INV:none"; return; }

                var inv = mc.player.getInventory();
                StringBuilder sb = new StringBuilder();

                sb.append("INV:HOTBAR:selected=").append(inv.selected).append(' ');
                boolean anyHb = false;

                for (int i = 0; i <= 8 && i < inv.items.size(); i++) {
                    ItemStack st = inv.items.get(i);
                    if (st.isEmpty()) continue;

                    ResourceLocation id = safeItemKey(st.getItem());
                    if (id == null) continue;

                    if (anyHb) sb.append(';');
                    anyHb = true;
                    sb.append(i).append('=').append(id).append('*').append(st.getCount());
                }
                if (!anyHb) sb.append("empty");

                sb.append(" | INV:");
                boolean any = false;

                for (int i = 0; i < inv.items.size(); i++) {
                    ItemStack st = inv.items.get(i);
                    if (st.isEmpty()) continue;

                    ResourceLocation id = safeItemKey(st.getItem());
                    if (id == null) continue;

                    if (any) sb.append(';');
                    any = true;
                    sb.append(i).append('=').append(id).append('*').append(st.getCount());
                }

                for (int i = 0; i < inv.armor.size(); i++) {
                    ItemStack st = inv.armor.get(i);
                    if (st.isEmpty()) continue;

                    ResourceLocation id = safeItemKey(st.getItem());
                    if (id == null) continue;

                    if (any) sb.append(';');
                    any = true;
                    sb.append("armor").append(i).append('=').append(id).append('*').append(st.getCount());
                }

                for (int i = 0; i < inv.offhand.size(); i++) {
                    ItemStack st = inv.offhand.get(i);
                    if (st.isEmpty()) continue;

                    ResourceLocation id = safeItemKey(st.getItem());
                    if (id == null) continue;

                    if (any) sb.append(';');
                    any = true;
                    sb.append("offhand").append(i).append('=').append(id).append('*').append(st.getCount());
                }

                if (!any) sb.append("empty");
                res[0] = sb.toString();
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(500, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleHas(String idRaw) {
        ResourceLocation rl = resolveItemIdStrict(idRaw);
        if (rl == null) return "ERR:item_not_found";

        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "HAS:none"; return; }

                Item item = getItemById(mc, rl);
                if (item == null) { res[0] = "ERR:item_not_found"; return; }

                int total = 0;
                var inv = mc.player.getInventory();

                for (ItemStack st : inv.items) if (!st.isEmpty() && st.is(item)) total += st.getCount();
                for (ItemStack st : inv.armor) if (!st.isEmpty() && st.is(item)) total += st.getCount();
                for (ItemStack st : inv.offhand) if (!st.isEmpty() && st.is(item)) total += st.getCount();

                res[0] = "HAS:" + rl + "=" + total;
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(500, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    // =========================
    // DROP (server-authoritative via ClickType.THROW)
    // =========================
    private static String handleDropServer(String itemRaw, int qty) {
        ResourceLocation rl = resolveItemIdStrict(itemRaw);
        if (rl == null) return "ERR:item_not_found";

        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }

                Item item = getItemById(mc, rl);
                if (item == null) { res[0] = "ERR:item_not_found"; return; }

                var inv = mc.player.getInventory();

                List<Integer> slots = new ArrayList<>();
                int have = 0;
                for (int i = 0; i < inv.items.size() && i <= 35; i++) {
                    ItemStack st = inv.items.get(i);
                    if (st.isEmpty() || !st.is(item)) continue;
                    slots.add(i);
                    have += st.getCount();
                }

                if (have <= 0) { res[0] = "ERR:not_found"; return; }

                int want = Math.min(have, qty);
                int remaining = want;

                AbstractContainerMenu menu = mc.player.containerMenu;
                boolean chestLike = isChestLikeOpen(mc);
                int containerSlots = chestLike ? computeContainerSlots(menu) : 0;

                for (int invSlot : slots) {
                    if (remaining <= 0) break;

                    ItemStack stNow = inv.items.get(invSlot);
                    int stackCount = stNow.isEmpty() ? 0 : stNow.getCount();
                    if (stackCount <= 0) continue;

                    int menuSlot = chestLike
                            ? mapPlayerInvSlotToMenuSlot(invSlot, containerSlots)
                            : mapPlayerInvSlotToInventoryMenuSlot(invSlot);

                    if (menuSlot < 0 || menuSlot >= menu.slots.size()) continue;

                    if (remaining >= stackCount) {
                        mc.gameMode.handleInventoryMouseClick(menu.containerId, menuSlot, 1, ClickType.THROW, mc.player);
                        remaining -= stackCount;
                    } else {
                        int n = Math.max(0, Math.min(remaining, 64));
                        for (int i = 0; i < n; i++) {
                            mc.gameMode.handleInventoryMouseClick(menu.containerId, menuSlot, 0, ClickType.THROW, mc.player);
                        }
                        remaining -= n;
                    }
                }

                int dropped = want - remaining;
                if (dropped < 0) dropped = 0;

                res[0] = "OK:drop " + rl + " qty=" + dropped;
            } catch (Exception e) {
                res[0] = "ERR:drop_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1200, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    // Maps player inventory index (0..35) to InventoryMenu slot indices
    private static int mapPlayerInvSlotToInventoryMenuSlot(int invSlot) {
        if (invSlot < 0 || invSlot > 35) return -1;
        if (invSlot <= 8) return 36 + invSlot; // hotbar
        return invSlot; // main inventory 9..35
    }

    // =========================
    // Chest ops
    // =========================
    private static AbstractContainerMenu getMenu(Minecraft mc) {
        if (mc == null || mc.player == null) return null;
        return mc.player.containerMenu;
    }

    private static boolean isChestLikeOpen(Minecraft mc) {
        if (mc == null || mc.player == null) return false;
        return mc.player.containerMenu != mc.player.inventoryMenu;
    }

    private static int computeContainerSlots(AbstractContainerMenu menu) {
        if (menu == null) return 0;
        int total = menu.slots.size();
        int container = total - 36; // player inv appended
        return Math.max(0, container);
    }

    private static int mapPlayerInvSlotToMenuSlot(int invSlot, int containerSlots) {
        if (invSlot < 0 || invSlot > 35) return -1;
        if (containerSlots < 0) containerSlots = 0;

        if (invSlot <= 8) return containerSlots + 27 + invSlot; // hotbar
        return containerSlots + (invSlot - 9); // main inventory
    }

    private static String handleChestOpen(int x, int y, int z) {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.level == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }

                Vec3 eye = new Vec3(mc.player.getX(), mc.player.getY() + mc.player.getEyeHeight(), mc.player.getZ());
                Vec3 hit = new Vec3(x + 0.5, y + 0.5, z + 0.5);
                if (eye.distanceTo(hit) > REACH_DIST) { res[0] = "ERR:too_far"; return; }

                BlockPos pos = new BlockPos(x, y, z);
                BlockHitResult bhr = new BlockHitResult(
                        Vec3.atCenterOf(pos),
                        Direction.UP,
                        pos,
                        false
                );
                mc.gameMode.useItemOn(mc.player, InteractionHand.MAIN_HAND, bhr);
                res[0] = "OK:open_sent";
            } catch (Exception e) {
                res[0] = "ERR:open_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(600, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        long deadline = System.currentTimeMillis() + 1500;
        while (System.currentTimeMillis() < deadline) {
            final boolean[] open = new boolean[1];
            CountDownLatch l2 = new CountDownLatch(1);

            mc.execute(() -> {
                try { open[0] = isChestLikeOpen(mc); }
                finally { l2.countDown(); }
            });

            try { l2.await(250, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}

            if (open[0]) {
                final int[] totalSlots = new int[1];
                CountDownLatch l3 = new CountDownLatch(1);

                mc.execute(() -> {
                    try {
                        AbstractContainerMenu menu = getMenu(mc);
                        chestContainerSlots = computeContainerSlots(menu);
                        chestOpen = true;
                        totalSlots[0] = (menu != null) ? menu.slots.size() : 0;
                    } finally { l3.countDown(); }
                });

                try { l3.await(250, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}

                return "OK:chest_open totalSlots=" + totalSlots[0] + " containerSlots=" + chestContainerSlots;
            }

            try { Thread.sleep(60); } catch (InterruptedException ignored) {}
        }

        chestOpen = false;
        chestContainerSlots = 0;
        return "ERR:not_opened";
    }

    private static String handleChestList() {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                if (!isChestLikeOpen(mc) || !chestOpen) { res[0] = "ERR:chest_not_open"; return; }

                AbstractContainerMenu menu = mc.player.containerMenu;
                chestContainerSlots = computeContainerSlots(menu);

                StringBuilder sb = new StringBuilder();
                sb.append("CHEST:slots=").append(chestContainerSlots).append(' ');

                boolean any = false;
                for (int i = 0; i < chestContainerSlots && i < menu.slots.size(); i++) {
                    Slot sl = menu.slots.get(i);
                    ItemStack st = sl.getItem();
                    if (st.isEmpty()) continue;

                    ResourceLocation id = safeItemKey(st.getItem());
                    if (id == null) continue;

                    if (any) sb.append(';');
                    any = true;
                    sb.append(i).append('=').append(id).append('*').append(st.getCount());
                }

                if (!any) sb.append("empty");
                res[0] = sb.toString();
            } catch (Exception e) {
                res[0] = "ERR:list_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(900, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleChestTake(int slot, int qty) {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }
                if (!isChestLikeOpen(mc) || !chestOpen) { res[0] = "ERR:chest_not_open"; return; }

                AbstractContainerMenu menu = mc.player.containerMenu;
                chestContainerSlots = computeContainerSlots(menu);

                if (slot < 0 || slot >= chestContainerSlots) { res[0] = "ERR:bad_slot"; return; }

                mc.gameMode.handleInventoryMouseClick(menu.containerId, slot, 0, ClickType.QUICK_MOVE, mc.player);

                if (qty == Integer.MAX_VALUE) res[0] = "OK:chest_take slot=" + slot + " moved=stack(all)";
                else res[0] = "OK:chest_take slot=" + slot + " moved=stack(qty_ignored)";
            } catch (Exception e) {
                res[0] = "ERR:take_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(900, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleChestPut(int invSlot, int qty) {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }
                if (!isChestLikeOpen(mc) || !chestOpen) { res[0] = "ERR:chest_not_open"; return; }

                AbstractContainerMenu menu = mc.player.containerMenu;
                chestContainerSlots = computeContainerSlots(menu);

                int menuSlot = mapPlayerInvSlotToMenuSlot(invSlot, chestContainerSlots);
                if (menuSlot < 0 || menuSlot >= menu.slots.size()) { res[0] = "ERR:bad_slot"; return; }

                mc.gameMode.handleInventoryMouseClick(menu.containerId, menuSlot, 0, ClickType.QUICK_MOVE, mc.player);

                if (qty == Integer.MAX_VALUE) res[0] = "OK:chest_put invSlot=" + invSlot + " moved=stack(all)";
                else res[0] = "OK:chest_put invSlot=" + invSlot + " moved=stack(qty_ignored)";
            } catch (Exception e) {
                res[0] = "ERR:put_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(900, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static String handleChestClose() {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null) { res[0] = "ERR:no_player"; return; }
                mc.player.closeContainer();
                chestOpen = false;
                chestContainerSlots = 0;
                res[0] = "OK:chest_close";
            } catch (Exception e) {
                res[0] = "ERR:close_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(600, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    // CHEST:PUTMATCH
    private static String handleChestPutMatch(String whatRaw, int qty) {
        Minecraft mc = Minecraft.getInstance();

        final String[] res = new String[1];
        CountDownLatch latch = new CountDownLatch(1);

        mc.execute(() -> {
            try {
                if (mc.player == null || mc.gameMode == null) { res[0] = "ERR:no_player"; return; }
                if (!isChestLikeOpen(mc) || !chestOpen) { res[0] = "ERR:chest_not_open"; return; }

                AbstractContainerMenu menu = mc.player.containerMenu;
                int containerSlots = computeContainerSlots(menu);
                chestContainerSlots = containerSlots;

                boolean putAll = whatRaw.equalsIgnoreCase("all");
                ResourceLocation rl = null;
                Item matchItem = null;

                if (!putAll) {
                    rl = resolveItemIdStrict(whatRaw);
                    if (rl == null) { res[0] = "ERR:item_not_found"; return; }
                    matchItem = getItemById(mc, rl);
                    if (matchItem == null) { res[0] = "ERR:item_not_found"; return; }
                }

                int remaining = (qty == Integer.MAX_VALUE) ? Integer.MAX_VALUE : Math.max(0, qty);
                int moved = 0;
                int stacks = 0;

                var inv = mc.player.getInventory();

                for (int invSlot = 0; invSlot <= 35; invSlot++) {
                    if (remaining <= 0) break;

                    ItemStack st = inv.items.get(invSlot);
                    if (st.isEmpty()) continue;

                    if (putAll) {
                        if (isProtectedForStoreAll(st)) continue;
                    } else {
                        if (!st.is(matchItem)) continue;
                    }

                    int count = st.getCount();
                    if (count <= 0) continue;

                    int menuSlot = mapPlayerInvSlotToMenuSlot(invSlot, containerSlots);
                    if (menuSlot < 0 || menuSlot >= menu.slots.size()) continue;

                    if (remaining != Integer.MAX_VALUE && count > remaining) continue;

                    mc.gameMode.handleInventoryMouseClick(menu.containerId, menuSlot, 0, ClickType.QUICK_MOVE, mc.player);
                    moved += count;
                    stacks += 1;

                    if (remaining != Integer.MAX_VALUE) remaining -= count;
                }

                if (moved <= 0) res[0] = "ERR:not_found";
                else res[0] = "OK:chest_putmatch what=" + (putAll ? "all" : rl) + " moved=" + moved + " stacks=" + stacks;

            } catch (Exception e) {
                res[0] = "ERR:putmatch_failed";
            } finally { latch.countDown(); }
        });

        try { if (!latch.await(1400, TimeUnit.MILLISECONDS)) return "ERR:timeout"; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return "ERR:interrupted"; }

        return res[0];
    }

    private static boolean isProtectedForStoreAll(ItemStack st) {
        if (st == null || st.isEmpty()) return false;
        ResourceLocation id = safeItemKey(st.getItem());
        if (id == null) return false;
        String sid = id.toString().toLowerCase(Locale.ROOT);

        if (sid.endsWith("_pickaxe")) return true;
        if (sid.endsWith("_axe")) return true;
        if (sid.endsWith("_shovel")) return true;
        if (sid.endsWith("_hoe")) return true;
        if (sid.endsWith("_sword")) return true;
        if (sid.contains("bow") || sid.contains("crossbow")) return true;
        if (sid.contains("shield")) return true;

        if (sid.endsWith("_helmet")) return true;
        if (sid.endsWith("_chestplate")) return true;
        if (sid.endsWith("_leggings")) return true;
        if (sid.endsWith("_boots")) return true;

        if (sid.contains("torch")) return true;

        return false;
    }

    // =========================
    // Chat
    // =========================
    private static void sendChat(String text) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            if (mc.player == null) return;
            ClientPacketListener conn = mc.player.connection;
            if (conn != null) conn.sendChat(text);
        });
    }

    // =========================
    // Baritone (reflection first, fallback to chat)
    // =========================
    private static boolean baritoneGoto(int x, int y, int z) {
        try {
            Object baritone = getPrimaryBaritone();
            if (baritone == null) return false;

            Method getCustomGoalProcess = baritone.getClass().getMethod("getCustomGoalProcess");
            Object goalProcess = getCustomGoalProcess.invoke(baritone);

            Class<?> goalBlockCls = Class.forName("baritone.pathing.goals.GoalBlock");
            Constructor<?> ctor = goalBlockCls.getConstructor(int.class, int.class, int.class);
            Object goalBlock = ctor.newInstance(x, y, z);

            Class<?> goalIface = Class.forName("baritone.api.pathing.goals.Goal");
            Method setGoalAndPath = goalProcess.getClass().getMethod("setGoalAndPath", goalIface);
            setGoalAndPath.invoke(goalProcess, goalBlock);

            return true;
        } catch (Throwable t) {
            System.out.println("[EllyBridge] Baritone goto failed: " + t);
            return false;
        }
    }

    private static boolean baritoneCancel() {
        try {
            Object baritone = getPrimaryBaritone();
            if (baritone == null) return false;

            Method getPathingBehavior = baritone.getClass().getMethod("getPathingBehavior");
            Object pb = getPathingBehavior.invoke(baritone);

            Method cancelEverything = pb.getClass().getMethod("cancelEverything");
            cancelEverything.invoke(pb);

            return true;
        } catch (Throwable t) {
            System.out.println("[EllyBridge] Baritone stop failed: " + t);
            return false;
        }
    }

    private static boolean baritoneFollowPlayer(String name) {
        try {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null) return false;

            var target = mc.level.players().stream()
                    .filter(p -> p.getGameProfile().getName().equalsIgnoreCase(name))
                    .findFirst().orElse(null);

            if (target == null) return false;

            Object baritone = getPrimaryBaritone();
            if (baritone == null) return false;

            Class<?> goalFollowCls = Class.forName("baritone.pathing.goals.GoalFollowEntity");
            Constructor<?> ctor = goalFollowCls.getConstructor(net.minecraft.world.entity.Entity.class, double.class);
            Object goalFollow = ctor.newInstance(target, 2.5);

            Method getCustomGoalProcess = baritone.getClass().getMethod("getCustomGoalProcess");
            Object goalProcess = getCustomGoalProcess.invoke(baritone);

            Class<?> goalIface = Class.forName("baritone.api.pathing.goals.Goal");
            Method setGoalAndPath = goalProcess.getClass().getMethod("setGoalAndPath", goalIface);
            setGoalAndPath.invoke(goalProcess, goalFollow);

            return true;
        } catch (Throwable t) {
            System.out.println("[EllyBridge] Baritone follow failed: " + t);
            return false;
        }
    }

    private static Object getPrimaryBaritone() {
        try {
            Class<?> apiCls = Class.forName("baritone.api.BaritoneAPI");
            Method getProvider = apiCls.getMethod("getProvider");
            Object provider = getProvider.invoke(null);

            Method getPrimary = provider.getClass().getMethod("getPrimaryBaritone");
            return getPrimary.invoke(provider);
        } catch (Throwable t) {
            return null;
        }
    }

    // =========================
    // Helpers
    // =========================
    private static boolean startsWithIgnoreCase(String s, String prefix) {
        return s != null && s.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    private static int parseQty(String s) {
        if (s == null) return -1;
        if (s.equalsIgnoreCase("all")) return Integer.MAX_VALUE;
        try { return Integer.parseInt(s); } catch (Exception e) { return -1; }
    }

    private static ResourceLocation resolveItemIdStrict(String raw) {
        if (raw == null) return null;

        String s = raw.trim().toLowerCase(Locale.ROOT);
        if (s.isEmpty()) return null;

        s = s.replace('-', '_');

        ResourceLocation rl = (s.indexOf(':') >= 0) ? ResourceLocation.tryParse(s) : ResourceLocation.tryParse("minecraft:" + s);
        if (rl == null) return null;

        return itemExists(Minecraft.getInstance(), rl) ? rl : null;
    }

    private static boolean itemExists(Minecraft mc, ResourceLocation id) {
        try {
            if (mc == null || mc.level == null) return false;
            return mc.level.registryAccess().registryOrThrow(Registries.ITEM).containsKey(id);
        } catch (Throwable t) {
            return false;
        }
    }

    private static Item getItemById(Minecraft mc, ResourceLocation id) {
        try {
            if (mc == null || mc.level == null) return null;
            return mc.level.registryAccess().registryOrThrow(Registries.ITEM).get(id);
        } catch (Throwable t) {
            return null;
        }
    }

    private static ResourceLocation safeItemKey(Item item) {
        try {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null) return null;
            return mc.level.registryAccess().registryOrThrow(Registries.ITEM).getKey(item);
        } catch (Throwable t) {
            return null;
        }
    }
}