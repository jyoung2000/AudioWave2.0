/*
 * The Android build lives outside the pnpm workspace on purpose.
 *
 * It consumes the player as *built output* — a folder of files copied into assets — rather than as
 * source, so nothing here needs Node, and a change to the web app cannot break this build in a way
 * that is only discovered here. The seam is a directory, which is the smallest seam there is.
 */
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "now-playing-android"
include(":app")
