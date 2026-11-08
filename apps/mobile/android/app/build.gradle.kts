plugins {
    id("com.android.application")
}

val coreDir = rootProject.file("../core")
val generatedBindings = layout.buildDirectory.dir("generated/uniffi")
val hostLibrary = coreDir.resolve("target/debug")

android {
    namespace = "com.runovahq.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.runovahq.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            kotlin.directories.add(generatedBindings.get().asFile.path)
        }
    }

    testOptions {
        unitTests.all {
            // JVM tests load the real core, built for this computer.
            it.systemProperty("jna.library.path", hostLibrary.path)
        }
    }
}

dependencies {
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation("junit:junit:4.13.2")
}

val hostLibraryFile = System.mapLibraryName("runova_ffi")

val buildHostCore by tasks.registering(Exec::class) {
    workingDir = coreDir
    commandLine("cargo", "build", "--jobs", "2", "-p", "runova-ffi")
}

val generateBindings by tasks.registering(Exec::class) {
    dependsOn(buildHostCore)
    workingDir = coreDir
    commandLine(
        "cargo", "run", "--jobs", "2", "-p", "runova-ffi", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", "target/debug/$hostLibraryFile",
        "--language", "kotlin", "--no-format",
        "--out-dir", generatedBindings.get().asFile.path,
    )
}

// Everything that compiles Kotlin needs the generated bindings first.
tasks.matching { it.name.startsWith("compile") || it.name == "preBuild" }.configureEach {
    if (name != generateBindings.name) dependsOn(generateBindings)
}

/** The core for the phone: arm64 for devices, x86_64 for the emulator. */
val buildAndroidCore by tasks.registering(Exec::class) {
    workingDir = coreDir
    commandLine(
        "cargo", "ndk", "-t", "arm64-v8a", "-t", "x86_64", "-P", "26",
        "-o", project.file("src/main/jniLibs").path,
        "build", "--release", "--jobs", "2", "-p", "runova-ffi",
    )
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") }.configureEach {
    dependsOn(buildAndroidCore)
}
