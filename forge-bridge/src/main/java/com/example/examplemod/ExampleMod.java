package com.example.examplemod;

import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.DistExecutor;
import net.minecraftforge.fml.common.Mod;

@Mod(ExampleMod.MODID)
public class ExampleMod {
    public static final String MODID = "ellybridge";

    public ExampleMod() {
        // Esegui solo su CLIENT, così non crascia su dedicated server
        DistExecutor.safeRunWhenOn(Dist.CLIENT, () -> ClientOnly::init);
    }

    private static class ClientOnly {
        static void init() {
            // avvia TCP server sul client bot
            ClientTcpBridge.start(25580);
        }
    }
}