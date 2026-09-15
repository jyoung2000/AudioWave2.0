# The tool libraries load classes by name from Python, so shrinking them needs rules nobody
# has written and the release build does not minify. This file exists so that decision is
# visible rather than implied by its absence.
-keep class com.yausername.** { *; }
