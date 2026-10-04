import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

// This project lives in an iCloud-synced folder (Desktop). iCloud creates
// "name 2.ext" conflict copies inside build outputs that break compilation,
// so build output is kept outside the synced tree.
layout.buildDirectory.set(
    File(System.getProperty("user.home"), "Library/Caches/StreetSweep-build/app"),
)

android {
    // The migration test reads the exported schemas, so they have to ship as assets.
    sourceSets.getByName("androidTest").assets.srcDir("$projectDir/schemas")

    namespace = "net.streetsweep"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = "net.streetsweep"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "1.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    /**
     * Signing for Play. The keystore and its passwords live outside the repository, in
     * ~/.streetsweep and ~/.gradle/gradle.properties, so there is nothing secret here to
     * leak. Absent them — anyone else's clone, or CI — the config simply is not created
     * and a release build falls back to unsigned, rather than failing to configure.
     */
    val uploadStore = (findProperty("STREETSWEEP_STORE_FILE") as String?)?.let(::File)
    signingConfigs {
        if (uploadStore?.exists() == true) {
            create("upload") {
                storeFile = uploadStore
                storePassword = findProperty("STREETSWEEP_STORE_PASSWORD") as String?
                keyAlias = findProperty("STREETSWEEP_KEY_ALIAS") as String?
                keyPassword = findProperty("STREETSWEEP_KEY_PASSWORD") as String?
                storeType = (findProperty("STREETSWEEP_STORE_TYPE") as String?) ?: "PKCS12"
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("upload")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

// iCloud syncing of this folder can create "name 2.ext" conflict copies that
// break compilation and resource merging. Purge them before every build.
val cleanICloudConflictCopies by tasks.registering(Delete::class) {
    delete(fileTree(projectDir.resolve("src")) { include("**/* [0-9].*") })
    delete(fileTree(projectDir.resolve("schemas")) { include("**/* [0-9].*") })
}
tasks.named("preBuild") { dependsOn(cleanICloudConflictCopies) }

tasks.withType<Test>().configureEach {
    // Test output is where the numbers from the real-area route check come out.
    testLogging { showStandardStreams = true }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.livedata.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.documentfile)
    implementation(libs.androidx.car.app)
    implementation(libs.androidx.car.app.projected)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.play.services.location)
    implementation(libs.osmdroid)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    // Real org.json for local unit tests (the Android SDK stubs throw "not mocked").
    testImplementation(libs.org.json)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
