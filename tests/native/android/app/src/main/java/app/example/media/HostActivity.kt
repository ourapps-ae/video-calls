package app.example.media

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class HostActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "Media component test host" })
    }
}
