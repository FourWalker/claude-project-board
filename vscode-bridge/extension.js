// Project Board Bridge: vscode://local.project-board-bridge/open?session=<id>
// The Claude Code extension's own link (vscode://anthropic.claude-code/open) always opens a
// full editor tab. Its `claude-vscode.editor.open` command, called with
// { programmatic: 'honor-preferred-location' }, opens the session in the Claude sidebar when
// claudeCode.preferredLocation is "sidebar". This handler makes that call.
'use strict'
const vscode = require('vscode')

exports.activate = context => {
  context.subscriptions.push(vscode.window.registerUriHandler({
    async handleUri(uri) {
      if (uri.path !== '/open') return
      const q = new URLSearchParams(uri.query)
      const session = q.get('session') || undefined
      if (session !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(session)) return
      const where = q.get('in') || vscode.workspace.getConfiguration('projectBoard').get('openChatsIn', 'sidebar')
      try {
        if (where === 'tab') {
          await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', session)
          return
        }
        const claude = vscode.workspace.getConfiguration('claudeCode')
        if (claude.get('preferredLocation') !== 'sidebar')
          await claude.update('preferredLocation', 'sidebar', vscode.ConfigurationTarget.Global)
        await vscode.commands.executeCommand(
          'claude-vscode.editor.open', session, undefined, undefined, undefined, undefined,
          { programmatic: 'honor-preferred-location' },
        )
      } catch (err) {
        vscode.window.showErrorMessage(`Project Board: couldn't open the chat (${err && err.message ? err.message : err}).`)
      }
    },
  }))
}

exports.deactivate = () => {}
