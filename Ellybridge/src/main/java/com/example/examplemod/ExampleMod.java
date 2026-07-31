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
            // Override with -Dellybridge.port=25580 when a different local port is needed.
            int port = Integer.getInteger("ellybridge.port", 25580);
            ClientTcpBridge.start(port);
        }
    }
}
