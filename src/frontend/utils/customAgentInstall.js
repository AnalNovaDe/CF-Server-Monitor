export const CUSTOM_INSTALLER_RELEASE = 'https://github.com/AnalNovaDe/CF-Server-Monitor/releases/download/agent-installer-1.0.5'
export const CUSTOM_AGENT_VERSION = '1.1.4-latency.1'
export const CUSTOM_INSTALLER_SHA256 = '478a0b22b1dd15bfa46c97dfea25ee46f5db4a046527f838b180760373ff1a5c'
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`

export function buildCustomAgentInstallCommand({ serverId, secret, baseUrl, options = {} }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(serverId || '')) return ''
  let url
  try { url = new URL(baseUrl) } catch { return '' }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !secret) return ''
  const allowed = ['collect_interval', 'interval', 'connection_mode', 'ping_mode', 'reset_day', 'ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4', 'interface', 'rx_correction', 'tx_correction']
  const args = [`-id=${serverId}`, `-secret=${secret}`, `-url=${String(baseUrl).replace(/\/$/, '')}/update`]
  for (const key of allowed) if (options[key] !== undefined && options[key] !== null) args.push(`-${key}=${options[key]}`)
  return [
    '(', 'set -e', 'umask 077',
    'cfm_installer=$(mktemp)',
    `trap 'rm -f -- "$cfm_installer"' EXIT`,
    `curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 10 --max-time 120 ${quote(`${CUSTOM_INSTALLER_RELEASE}/install-custom-agent.sh`)} -o "$cfm_installer"`,
    `printf '%s  %s\\n' ${quote(CUSTOM_INSTALLER_SHA256)} "$cfm_installer" | sha256sum -c -`,
    `bash "$cfm_installer" ${args.map(quote).join(' ')}`,
    ')'
  ].join('\n')
}
