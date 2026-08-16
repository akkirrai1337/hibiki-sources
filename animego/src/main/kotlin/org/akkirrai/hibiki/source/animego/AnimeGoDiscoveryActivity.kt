package org.akkirrai.hibiki.source.animego

import android.app.Activity
import android.os.Bundle

/** Never shown; exists only as a manifest anchor for source-extension discovery. */
class AnimeGoDiscoveryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        finish()
    }
}
