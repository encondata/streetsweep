// Top-level build file where you can add configuration options common to all sub-projects/modules.

// This project lives in an iCloud-synced folder (Desktop). iCloud creates
// "name 2.ext" conflict copies inside build outputs that break compilation,
// so build output is kept outside the synced tree.
layout.buildDirectory.set(
    File(System.getProperty("user.home"), "Library/Caches/StreetSweep-build/root"),
)

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.ksp) apply false
}
