plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
    id("signing")
}

android {
    namespace = "com.susatest.signals"
    compileSdk = 35

    defaultConfig {
        // PixelCopy, the only reliable way to snapshot a hardware-accelerated
        // window, requires API 24.
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }

    publishing {
        singleVariant("release") {
            // Ships sources so a customer can step into the SDK while debugging
            // their own integration, rather than decompiling it.
            withSourcesJar()
            // Maven Central rejects a bundle without one. It is also the only
            // API documentation an IDE can show at the call site.
            withJavadocJar()
        }
    }
}

/**
 * Deliberately zero third-party dependencies.
 *
 * This library is embedded in other companies' apps. Every dependency we add is a
 * potential version conflict with the host app (the classic case being two
 * incompatible OkHttp majors), and conflicts caused by an SDK are debugged by the
 * customer, not by us. HttpURLConnection and a hand-rolled JSON writer are less
 * elegant than the alternatives and worth it.
 */
dependencies {
    testImplementation("junit:junit:4.13.2")

    // Instrumented tests only — these never reach a consumer's app, so the
    // zero-dependency rule above still holds for the shipped library.
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
}

/**
 * Publication wiring for Maven Central.
 *
 * Credentials come from the environment, never a checked-in file — a token in
 * the repo is a token in every clone and every CI log that prints the workspace.
 *
 *   ./gradlew :signals:publishReleasePublicationToStagingRepository -Pversion=1.0.0
 *
 * Central validates the POM on receipt and rejects anything missing a license,
 * a developer, an scm block, or a signature. Those fields are therefore not
 * decoration — a publish without them fails at the far end, after the build has
 * already reported success.
 */
val releaseVersion = (findProperty("version") as String?)?.takeIf { it != "unspecified" } ?: "0.0.0-SNAPSHOT"

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "com.susatest"
            artifactId = "signals"
            version = releaseVersion

            // afterEvaluate: the Android plugin only creates the `release`
            // component once its own configuration has completed.
            afterEvaluate {
                from(components["release"])
            }

            pom {
                name.set("Susa Signals")
                description.set(
                    "Bug reporting, UX research, session replay, and product analytics for Android.",
                )
                url.set("https://github.com/monk0062006/susa-signals")

                licenses {
                    license {
                        name.set("Apache License 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                    }
                }

                developers {
                    developer {
                        id.set("susatest")
                        name.set("Susa")
                        url.set("https://susatest.com")
                    }
                }

                scm {
                    url.set("https://github.com/monk0062006/susa-signals")
                    connection.set("scm:git:https://github.com/monk0062006/susa-signals.git")
                    developerConnection.set("scm:git:ssh://git@github.com/monk0062006/susa-signals.git")
                }
            }
        }
    }

    repositories {
        /**
         * A directory, not a server.
         *
         * Central's Portal API takes a single signed bundle rather than the
         * per-artifact uploads the old OSSRH accepted, so the build stages
         * locally and CI uploads the zip. This also keeps the release
         * reproducible: the exact bytes that get published can be inspected
         * before anything leaves the machine.
         */
        maven {
            name = "staging"
            url = uri(layout.buildDirectory.dir("staging-repo"))
        }
    }
}

/**
 * Signing.
 *
 * In-memory keys rather than a keyring file: CI has no GPG home, and writing the
 * private key to disk to satisfy the plugin would leave it in the workspace for
 * anything later in the job to read.
 *
 * Unsigned local builds stay possible — required only when a key is present, so
 * `assembleRelease` on a developer machine does not demand a passphrase.
 */
signing {
    val signingKey = System.getenv("SIGNING_KEY")
    val signingPassword = System.getenv("SIGNING_PASSWORD")

    isRequired = signingKey != null

    if (signingKey != null) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications["release"])
    }
}
