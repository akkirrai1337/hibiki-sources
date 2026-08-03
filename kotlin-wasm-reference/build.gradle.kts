import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl

plugins {
    kotlin("multiplatform") version "2.3.21"
    kotlin("plugin.serialization") version "2.3.21"
}

@OptIn(ExperimentalWasmDsl::class)
kotlin {
    wasmWasi {
        binaries.executable()
        nodejs()
    }

    sourceSets {
        val wasmWasiMain by getting {
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
            }
        }
    }

    compilerOptions {
        freeCompilerArgs.add("-opt-in=kotlin.wasm.ExperimentalWasmInterop")
        freeCompilerArgs.add("-opt-in=kotlin.wasm.unsafe.UnsafeWasmMemoryApi")
    }
}
