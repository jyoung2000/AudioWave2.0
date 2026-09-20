package com.nowplaying.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parts of `Tools` that are ordinary Kotlin, tested on the JVM with no device and no emulator.
 *
 * These are the decisions where being wrong is dangerous rather than merely broken: which addresses
 * the phone will fetch from, and which it refuses because they point back inside a network. Nothing
 * here touches an Android API, so `testDebugUnitTest` runs it in seconds.
 *
 * The private-address table this pins was previously a handful of string prefixes that let CGNAT,
 * link-local (including the cloud metadata address), IPv6 unique-local and every obfuscated form of
 * loopback straight through.
 */
class ToolsTest {
  @Test
  fun `refuses loopback in every form it can be written`() {
    for (host in listOf("localhost", "LOCALHOST", "127.0.0.1", "127.1", "0x7f.1", "2130706433", "0.0.0.0", "[::1]", "::1", "::ffff:127.0.0.1")) {
      assertTrue("$host should be local", Tools.isLocal(host))
    }
  }

  @Test
  fun `refuses the private ranges, including the ones a prefix check missed`() {
    for (host in listOf("10.0.0.1", "192.168.1.5", "172.16.0.1", "172.31.255.254", "100.64.0.1", "100.127.255.255", "169.254.1.1", "169.254.169.254", "198.18.0.1", "224.0.0.1")) {
      assertTrue("$host should be local", Tools.isLocal(host))
    }
  }

  @Test
  fun `refuses IPv6 unique-local and the transition ranges that embed an IPv4 address`() {
    // fc00::/7 was absent entirely; 6to4 and NAT64 can each carry a private IPv4 target.
    for (host in listOf("fc00::1", "fd12:3456::1", "fe80::1", "[fd00::1]", "2002:7f00:0001::", "64:ff9b::1", "2001:0:1::1")) {
      assertTrue("$host should be local", Tools.isLocal(host))
    }
  }

  @Test
  fun `allows ordinary public addresses`() {
    for (host in listOf("youtube.com", "www.youtube.com", "93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111")) {
      assertFalse("$host should not be local", Tools.isLocal(host))
    }
  }

  @Test
  fun `refuses the names a network hands out for itself`() {
    for (host in listOf("nas.local", "printer.localhost", "db.internal", "metadata.google.internal", "example.local.")) {
      assertTrue("$host should be local", Tools.isLocal(host))
    }
  }

  @Test
  fun `takes its allow-list from the generated file, not a second copy`() {
    assertEquals(AllowedHosts.hosts, Tools.allowedHosts)
    assertTrue("the allow-list must not be empty", Tools.allowedHosts.isNotEmpty())
    assertTrue("youtube.com should be allowed", Tools.allowedHosts.contains("youtube.com"))
  }
}
