// A real demo app that embeds the Signals SDK and exercises the FULL feedback
// flow — screenshot capture and session replay included — on a real device.
// Exists to prove the product works when a person actually uses it, not just
// that the wire contract holds.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.susatest.demo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.susatest.demo"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":signals"))
}
