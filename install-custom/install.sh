#!/usr/bin/env bash
# Fixed release bootstrap for Linux systemd. No secrets belong in this file.
# installer-release: agent-installer-1.0.3
set -Eeuo pipefail
umask 077
cfm_release='https://github.com/AnalNovaDe/CF-Server-Monitor/releases/download/agent-1.0.19-latency.4'
cfm_version='CF-Server-Monitor Go Probe 1.0.19-latency.4'
cfm_id='' cfm_secret='' cfm_url=''
cfm_args=("$@")
for cfm_arg in "$@"; do
  case "$cfm_arg" in
    -id=*) cfm_id=${cfm_arg#*=} ;;
    -secret=*) cfm_secret=${cfm_arg#*=} ;;
    -url=*) cfm_url=${cfm_arg#*=} ;;
    -auto_update=*|-auto-update=*|--no-start|--no_start) printf 'Reserved install option\n' >&2; exit 1 ;;
  esac
done
cfm_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && -d /run/systemd/system ]] || cfm_die 'Custom installation requires Linux systemd.'
[[ $cfm_id =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ && -n $cfm_secret ]] || cfm_die 'Missing server ID or secret.'
[[ $cfm_url == https://*/update ]] || cfm_die 'An HTTPS /update URL is required.'
case "$(uname -m)" in
  x86_64|amd64) cfm_arch=amd64; cfm_sha=e9e00d36e5d4d25b58043e9167cbbcb4d43c7073a55c7b87d1452d54cbf02bcb ;;
  aarch64|arm64) cfm_arch=arm64; cfm_sha=c5f77ab18ce3504b7325ecd0cb561e5026709c829da49a6bea12137838ed5ddc ;;
  *) cfm_die 'Only Linux amd64 and arm64 are supplied in this release.' ;;
esac
for cfm_tool in curl sha256sum awk systemctl mktemp cp mv chmod; do
  command -v "$cfm_tool" >/dev/null || cfm_die "Required command missing: $cfm_tool"
done
if [[ $EUID -eq 0 ]]; then
  cfm_conf=/etc/config/cf-probe/config.conf
  cfm_bin=/usr/local/bin/cf-probe
  cfm_unit=/etc/systemd/system/cf-probe.service
  cfm_systemctl=(systemctl)
  [[ ! -f /home/cfsm/.cf-probe/config.conf ]] || cfm_die 'An existing cfsm user installation was found. Select the dedicated cfsm user in the copy dialog.'
else
  cfm_conf="$HOME/.cf-probe/config.conf"
  cfm_bin="$HOME/.cf-probe/bin/cf-probe"
  cfm_unit="$HOME/.config/systemd/user/cf-probe.service"
  cfm_systemctl=(systemctl --user)
  [[ ! -f /etc/config/cf-probe/config.conf ]] || cfm_die 'A system installation exists. Use its original installation user.'
fi
for cfm_file in "$cfm_conf" "$cfm_bin" "$cfm_unit"; do
  [[ ! -L $cfm_file ]] || cfm_die 'Unexpected symlink in installation paths; review manually.'
  [[ ! -e $cfm_file || -f $cfm_file ]] || cfm_die 'Unexpected non-file installation path.'
done
if [[ -f $cfm_conf ]]; then
  cfm_existing=$(awk -F= '/^[[:space:]]*SERVER_ID[[:space:]]*=/ {v=substr($0,index($0,"=")+1); gsub(/^[[:space:]\"]+|[[:space:]\"]+$/,"",v); id=v} END{print id}' "$cfm_conf")
  [[ $cfm_existing == "$cfm_id" ]] || cfm_die 'Existing SERVER_ID differs; no files changed.'
fi
cfm_tmp=$(mktemp -d "$HOME/.cfm-download-XXXXXXXX")
cfm_backup='' cfm_stage='' cfm_changed=0 cfm_old_active=0 cfm_old_enabled=0
cfm_cleanup() { [[ -z $cfm_stage ]] || rm -f -- "$cfm_stage"; rm -rf -- "$cfm_tmp"; }
trap cfm_cleanup EXIT
cfm_fail() {
  cfm_code=$1
  trap - ERR INT TERM
  set +e
  if [[ $cfm_changed -eq 1 ]]; then
    "${cfm_systemctl[@]}" stop cf-probe.service
    "${cfm_systemctl[@]}" disable cf-probe.service
    cfm_restored=1
    for cfm_name in binary config unit; do
      case "$cfm_name" in binary) cfm_dst=$cfm_bin ;; config) cfm_dst=$cfm_conf ;; unit) cfm_dst=$cfm_unit ;; esac
      if [[ -f $cfm_backup/$cfm_name ]]; then cp -p -- "$cfm_backup/$cfm_name" "$cfm_dst" || cfm_restored=0
      else rm -f -- "$cfm_dst" || cfm_restored=0; fi
    done
    "${cfm_systemctl[@]}" daemon-reload || cfm_restored=0
    if [[ $cfm_old_enabled -eq 1 ]]; then "${cfm_systemctl[@]}" enable cf-probe.service || cfm_restored=0; fi
    if [[ $cfm_old_active -eq 1 ]]; then "${cfm_systemctl[@]}" start cf-probe.service || cfm_restored=0; fi
    printf 'Installation failed. Restore result=%s. BACKUP_PATH=%s\n' "$cfm_restored" "$cfm_backup" >&2
  fi
  exit "$cfm_code"
}
trap 'cfm_fail $?' ERR
trap 'cfm_fail 130' INT
trap 'cfm_fail 143' TERM
curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 10 --max-time 180 "$cfm_release/cf-probe-linux-$cfm_arch" -o "$cfm_tmp/cf-probe"
printf '%s  %s\n' "$cfm_sha" "$cfm_tmp/cf-probe" | sha256sum -c -
chmod 700 "$cfm_tmp/cf-probe"
[[ $("$cfm_tmp/cf-probe" version) == "$cfm_version" ]] || cfm_die 'Unexpected binary version; no installation files changed.'
cfm_status=$(curl --proto '=https' -sS --connect-timeout 10 --max-time 30 --max-redirs 0 -o "$cfm_tmp/readiness.json" -w '%{http_code}' \
  -H "Authorization: Bearer $cfm_secret" -H 'Content-Type: application/json' \
  --data "{\"id\":\"$cfm_id\"}" "${cfm_url%/update}/update/latency-check")
[[ $cfm_status == 200 ]] || cfm_die "Worker readiness check failed ($cfm_status). Check the node allowlist and migration; no installation files changed."
[[ $(< "$cfm_tmp/readiness.json") == '{"enabled":true,"version":"1.0.19-latency.4"}' ]] || cfm_die 'Worker did not confirm the custom installation protocol; no installation files changed.'
"${cfm_systemctl[@]}" show-environment >/dev/null
cfm_fragment=$("${cfm_systemctl[@]}" show cf-probe.service -p FragmentPath --value 2>/dev/null || true)
[[ -z $cfm_fragment || $cfm_fragment == "$cfm_unit" ]] || cfm_die 'Unexpected service location; review manually.'
if "${cfm_systemctl[@]}" is-active --quiet cf-probe.service; then cfm_old_active=1; fi
if "${cfm_systemctl[@]}" is-enabled --quiet cf-probe.service; then cfm_old_enabled=1; fi
cfm_backup=$(mktemp -d "$HOME/cfm-agent-backup-XXXXXXXX")
for cfm_name in binary config unit; do
  case "$cfm_name" in binary) cfm_src=$cfm_bin ;; config) cfm_src=$cfm_conf ;; unit) cfm_src=$cfm_unit ;; esac
  if [[ -f $cfm_src ]]; then cp -p -- "$cfm_src" "$cfm_backup/$cfm_name"; fi
done
printf 'BACKUP_PATH=%s\n' "$cfm_backup"
cfm_changed=1
"$cfm_tmp/cf-probe" install "${cfm_args[@]}" -auto_update=0 --no-start
cfm_stage=$(mktemp "$cfm_conf.latency.XXXXXXXX")
awk '!/^[[:space:]]*(LATENCY_DETAIL|AUTO_UPDATE)[[:space:]]*=/ {print} END{print "LATENCY_DETAIL=\"1\""; print "AUTO_UPDATE=\"0\""}' "$cfm_conf" > "$cfm_stage"
chmod 600 "$cfm_stage"
mv -f -- "$cfm_stage" "$cfm_conf"
cfm_stage=''
"${cfm_systemctl[@]}" daemon-reload
"${cfm_systemctl[@]}" enable cf-probe.service
"${cfm_systemctl[@]}" start cf-probe.service
for cfm_attempt in 1 2 3 4 5; do sleep 1; "${cfm_systemctl[@]}" is-active --quiet cf-probe.service; done
"${cfm_systemctl[@]}" is-enabled --quiet cf-probe.service
trap - ERR INT TERM
printf 'Installed: 1.0.19-latency.4. BACKUP_PATH=%s\n' "$cfm_backup"
"${cfm_systemctl[@]}" show cf-probe.service -p ActiveState -p MainPID -p UnitFileState
printf 'LATENCY_DETAIL=1 AUTO_UPDATE=0. Verify new history after 2-3 minutes and review free usage.\n'
