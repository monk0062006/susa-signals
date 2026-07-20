plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.markerusa.feedback"
    compileSdk = 35

    defaultConfig {
        // PixelCopy, the only reliable way to snapshot a hardware-accelerated
        // window, requires API 24.
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
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
}
