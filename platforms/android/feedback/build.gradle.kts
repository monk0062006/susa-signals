plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
}

android {
    namespace = "io.markerusa.feedback"
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
 * Publication wiring.
 *
 * Credentials come from the environment, never a checked-in file — a token in
 * the repo is a token in every clone and every CI log that prints the workspace.
 *
 *   MAVEN_URL=... MAVEN_USER=... MAVEN_PASSWORD=... ./gradlew :feedback:publish
 */
publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "io.markerusa"
            artifactId = "feedback"
            version = "0.1.0"

            // afterEvaluate: the Android plugin only creates the `release`
            // component once its own configuration has completed.
            afterEvaluate {
                from(components["release"])
            }

            pom {
                name.set("Feedback SDK")
                description.set("Bug reporting and UX research for Android.")
                url.set("https://github.com/monk0062006/markerio-usa-core")
            }
        }
    }

    repositories {
        maven {
            name = "internal"
            // Placeholder host: publishing fails loudly if MAVEN_URL is unset,
            // rather than silently succeeding against the wrong registry.
            url = uri(System.getenv("MAVEN_URL") ?: "https://example.invalid/repository")
            credentials {
                username = System.getenv("MAVEN_USER")
                password = System.getenv("MAVEN_PASSWORD")
            }
        }
    }
}
