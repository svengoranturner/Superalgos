'use strict'

/*
    Alert delivery. ntfy needs no account and reaches a phone in one step,
    which is why it is the default; Telegram is there because the host repo
    already uses it elsewhere.
*/

exports.newChannel = function (config) {
    switch (config.channel) {
        case 'ntfy': return newNtfy(config)
        case 'telegram': return newTelegram(config)
        case 'console': return newConsole()
        default: return newConsole()
    }
}

function newNtfy (config) {
    return {
        name: 'ntfy',
        async send (title, body) {
            const response = await fetch('https://ntfy.sh/' + encodeURIComponent(config.ntfyTopic), {
                method: 'POST',
                headers: { Title: title, Priority: 'default', Tags: 'coin' },
                body
            })
            if (!response.ok) { throw new Error('ntfy returned HTTP ' + response.status) }
        }
    }
}

function newTelegram (config) {
    return {
        name: 'telegram',
        async send (title, body) {
            const url = 'https://api.telegram.org/bot' + config.telegramBotToken + '/sendMessage'
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: config.telegramChatId, text: title + '\n\n' + body })
            })
            if (!response.ok) { throw new Error('Telegram returned HTTP ' + response.status) }
        }
    }
}

function newConsole () {
    return {
        name: 'console',
        async send (title, body) { console.log('\n=== ' + title + ' ===\n' + body + '\n') }
    }
}

/*
    Fires each alert at most once ever, keyed on (rule, listing). Without
    this the ending-soon poller would re-alert the same lot every five
    minutes for two hours.
*/
exports.newDispatcher = function (db, channel) {
    const claim = db.prepare(
        'INSERT OR IGNORE INTO alert (rule, browse_id, fired_at, payload) VALUES (?,?,?,?)'
    )

    return {
        async dispatch (alert, title, body) {
            const result = claim.run(alert.rule, alert.browseId, new Date().toISOString(), JSON.stringify(alert))
            if (result.changes === 0) { return false }   /* already fired */
            await channel.send(title, body)
            return true
        }
    }
}
