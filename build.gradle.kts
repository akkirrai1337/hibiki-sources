import com.android.build.api.dsl.ApplicationExtension

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}

/**
 * Shared release signing for every source-extension module. New modules never need to touch
 * this -- applying `com.android.application` is enough to pick it up.
 */
fun signingValue(name: String): String? =
    System.getenv(name) ?: providers.gradleProperty(name).orNull

val releaseStoreFile = signingValue("HIBIKI_SOURCES_STORE_FILE")
val releaseStorePassword = signingValue("HIBIKI_SOURCES_STORE_PASSWORD")
val releaseKeyAlias = signingValue("HIBIKI_SOURCES_KEY_ALIAS")
val releaseKeyPassword = signingValue("HIBIKI_SOURCES_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

subprojects {
    plugins.withId("com.android.application") {
        extensions.configure<ApplicationExtension> {
            signingConfigs {
                create("release") {
                    if (!releaseStoreFile.isNullOrBlank()) {
                        storeFile = file(releaseStoreFile)
                    }
                    storePassword = releaseStorePassword
                    keyAlias = releaseKeyAlias
                    keyPassword = releaseKeyPassword
                }
            }
            buildTypes {
                getByName("release") {
                    if (hasReleaseSigning) {
                        signingConfig = signingConfigs.getByName("release")
                    }
                }
            }
        }
    }
}
