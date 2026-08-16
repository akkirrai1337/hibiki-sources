package org.akkirrai.hibiki.source.animepahe

import android.app.Activity
import android.os.Bundle

/** Never shown; exists only as a manifest anchor for source-extension discovery. */
class AnimePaheDiscoveryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        finish()
    }
}
