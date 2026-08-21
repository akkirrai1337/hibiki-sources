plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "org.akkirrai.hibiki.source.kickassanime"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "org.akkirrai.hibiki.source.kickassanime"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "1.2"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.hibiki.parsers)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
}
