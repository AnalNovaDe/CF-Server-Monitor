import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCustomAgentInstallCommand, CUSTOM_INSTALLER_SHA256, CUSTOM_INSTALLER_RELEASE } from '../src/frontend/utils/customAgentInstall.js';
import { handleLatencyInstallCheck } from '../src/handlers/latencyDetail.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

const id = '11111111-2222-3333-4444-555555555555';
const installerURL = new URL('../install-custom/install.sh', import.meta.url);
const shellQuote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const digest = value => createHash('sha256').update(value).digest('hex');

test('copy command pins the published installer and quotes server settings literally', async () => {
  const script = (await readFile(installerURL, 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(digest(script), CUSTOM_INSTALLER_SHA256);
  const secret = "secret'$(touch /tmp/never-run)`uname`";
  const cmd = buildCustomAgentInstallCommand({ serverId:id, secret, baseUrl:'https://monitor.example/', options:{node_1:'',ct:"host'; exit 7; '",reset_day:1,auto_update:1} });
  assert.ok(cmd.includes(`${CUSTOM_INSTALLER_RELEASE}/install-custom-agent.sh`));
  assert.ok(cmd.includes(CUSTOM_INSTALLER_SHA256));
  assert.ok(cmd.includes(shellQuote(`-secret=${secret}`)));
  assert.ok(cmd.includes(shellQuote("-ct=host'; exit 7; '")));
  assert.ok(cmd.includes("'-node_1='"));
  assert.ok(cmd.includes("'-url=https://monitor.example/update'"));
  assert.ok(!cmd.includes('-auto_update='));
  for (const baseUrl of ['http://monitor.example','https://user:pass@monitor.example','https://monitor.example/?token=secret','invalid']) {
    assert.equal(buildCustomAgentInstallCommand({serverId:id,secret,baseUrl}), '');
  }
  assert.equal(buildCustomAgentInstallCommand({serverId:'invalid',secret,baseUrl:'https://monitor.example'}),'');
});

test('installation readiness enforces auth, six-node opt-in, server existence and storage availability without writes', async () => {
  const queries = [];
  let exists = true, storage = true;
  const env = {API_SECRET:'test-secret',LATENCY_DETAIL_SERVER_IDS:id,DB:{prepare(sql){
    queries.push(sql);
    return {bind(){return {async first(){return exists?{id,is_hidden:1}:null}}},async all(){if(!storage)throw Error('unavailable');return {results:[]}}};
  }}};
  const request = (secret='test-secret',body={id}) => new Request('https://test/update/latency-check',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify(body)});
  assert.equal((await handleLatencyInstallCheck(request('wrong'),env)).status,401);
  assert.equal(queries.length,0);
  assert.equal((await handleLatencyInstallCheck(request('test-secret',{id:'not-enabled'}),env)).status,403);
  assert.equal(queries.length,0);
  assert.equal((await handleLatencyInstallCheck(request(),{...env,LATENCY_DETAIL_SERVER_IDS:'1,2,3,4,5,6,7'})).status,403);
  clearServersListCache();
  exists=false;
  assert.equal((await handleLatencyInstallCheck(request(),env)).status,404);
  clearServersListCache();exists=true;storage=false;
  assert.equal((await handleLatencyInstallCheck(request(),env)).status,503);
  clearServersListCache();storage=true;
  const ready=await handleLatencyInstallCheck(request(),env);
  assert.equal(ready.status,200);
  assert.deepEqual(await ready.json(),{enabled:true,version:'1.0.19-latency.3'});
  assert.ok(queries.every(sql=>sql.startsWith('SELECT ')));
  clearServersListCache();
});

test('merged admin login accepts Chinese usernames and only authenticated settings expose install eligibility', async () => {
  const env={API_SECRET:'test-secret',LATENCY_DETAIL_SERVER_IDS:id};
  const sys={username:'测试管理员',password:''};
  const request=(body,token)=>new Request('https://test/admin/api',{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:JSON.stringify(body)});
  const login=await handleAdminAPI(request({action:'login',username:sys.username,password:env.API_SECRET}),env,sys);
  assert.equal(login.status,200);
  const {token}=await login.json();
  assert.ok(token);
  assert.equal((await handleAdminAPI(request({action:'login',username:sys.username,password:'wrong'}),env,sys)).status,401);
  const unauthorized=await handleAdminAPI(request({action:'get_settings'}),env,sys);
  assert.equal(unauthorized.status,401);
  assert.ok(!(await unauthorized.text()).includes(id));
  const settings=await handleAdminAPI(request({action:'get_settings'},token),env,sys);
  assert.equal(settings.status,200);
  assert.deepEqual((await settings.json()).latency_detail_server_ids,[id]);
});

// Linux CI runs an isolated shell integration test with a fake download, Agent and
// systemctl. Absolute system paths and binary hashes are mapped to the test fixture;
// no actual Agent or system service is installed or stopped.
test('Linux installer enables boot startup and restores files, running state and enablement independently', {skip:process.platform!=='linux'?'Linux shell integration runs in GitHub Actions':false}, async () => {
  const root=await mkdtemp(join(tmpdir(),'cfm-install-test-'));
  try {
    const tools=join(root,'tools'),home=join(root,'home');
    await mkdir(tools);await mkdir(home);
    const executable=async(name,source)=>{const path=join(tools,name);await writeFile(path,source);await chmod(path,0o700);return path;};
    const fakeAgent=await executable('fake-agent',`#!/bin/bash
set -eu
if [[ $1 == version ]]; then echo 'CF-Server-Monitor Go Probe 1.0.19-latency.3'; exit; fi
# The real Agent install stops AND disables the old unit, even with --no-start.
mode=(); [[ $CFM_TEST_MODE != user ]] || mode=(--user)
systemctl "\${mode[@]}" stop cf-probe.service
systemctl "\${mode[@]}" disable cf-probe.service
mkdir -p "$(dirname "$CFM_TEST_BIN")" "$(dirname "$CFM_TEST_UNIT")" "$(dirname "$CFM_TEST_CONF")"
cp "$0" "$CFM_TEST_BIN"
printf 'SERVER_ID="${id}"\\nSECRET="test-secret"\\nWORKER_URL="https://test/update"\\nLATENCY_DETAIL="0"\\nAUTO_UPDATE="1"\\n' > "$CFM_TEST_CONF"
echo new-unit > "$CFM_TEST_UNIT"
if [[ \${CFM_TEST_FAIL:-} == install ]]; then exit 7; fi
`);
    const fakeHash=digest(await readFile(fakeAgent));
    await executable('uname','#!/bin/bash\n[[ $1 == -s ]] && echo Linux || echo x86_64\n');
    await executable('sleep','#!/bin/bash\nexit 0\n');
    await executable('curl',`#!/bin/bash
set -eu
out=''; request=''
for arg in "$@"; do
  if [[ \${previous:-} == -o ]]; then out=$arg; fi
  [[ $arg != *latency-check ]] || request=check
  previous=$arg
done
if [[ $request == check ]]; then
  if [[ \${CFM_TEST_HTML:-0} == 1 ]]; then echo '<html>old frontend</html>' > "$out"
  else echo '{"enabled":true,"version":"1.0.19-latency.3"}' > "$out"; fi
  printf '%s' "\${CFM_TEST_STATUS:-200}"
else cp ${shellQuote(fakeAgent)} "$out"; fi
`);
    await executable('systemctl',`#!/bin/bash
set -eu
if [[ $CFM_TEST_MODE == user ]]; then [[ \${1:-} == --user ]]; shift
else [[ \${1:-} != --user ]]; fi
case "$1" in
show-environment|daemon-reload) exit 0;;
show)
  if [[ \${*: -1} == --value ]]; then
    [[ ! -f $CFM_TEST_UNIT ]] || echo "$CFM_TEST_UNIT"
  else
    printf 'ActiveState=%s\\nMainPID=1\\nUnitFileState=%s\\n' "$(cat "$HOME/service-state")" "$(cat "$HOME/enable-state")"
  fi
  exit 0;;
enable)
  if [[ \${CFM_TEST_FAIL:-} == enable || \${CFM_TEST_FAIL:-} == enable-noop ]] && [[ ! -e "$HOME/enable-failure-used" ]]; then
    touch "$HOME/enable-failure-used"
    [[ $CFM_TEST_FAIL == enable-noop ]] && exit 0
    exit 9
  fi
  echo enabled > "$HOME/enable-state";;
disable) echo disabled > "$HOME/enable-state";;
is-active) [[ $(cat "$HOME/service-state" 2>/dev/null) == active ]];;
is-enabled) [[ $(cat "$HOME/enable-state" 2>/dev/null) == enabled ]];;
stop) echo inactive > "$HOME/service-state";;
start) echo active > "$HOME/service-state";;
esac
`);
    for (const mode of ['user','system']) {
      const modeHome=join(home,mode);await mkdir(modeHome);
      const conf=mode==='user'?join(modeHome,'.cf-probe/config.conf'):join(modeHome,'etc/config.conf');
      const binary=mode==='user'?join(modeHome,'.cf-probe/bin/cf-probe'):join(modeHome,'bin/cf-probe');
      const unit=mode==='user'?join(modeHome,'.config/systemd/user/cf-probe.service'):join(modeHome,'systemd/cf-probe.service');
      let script=(await readFile(installerURL,'utf8')).replaceAll('\r\n','\n');
      script=script.replace('-d /run/systemd/system',`-d ${shellQuote(root)}`)
        .replace('if [[ $EUID -eq 0 ]]; then',`if ${mode==='system'?'true':'false'}; then`)
        .replaceAll('/home/cfsm/.cf-probe/config.conf',join(root,'unused-cfsm-config'))
        .replaceAll('/etc/config/cf-probe/config.conf',mode==='system'?conf:join(root,'unused-system-config'))
        .replaceAll('/usr/local/bin/cf-probe',binary)
        .replaceAll('/etc/systemd/system/cf-probe.service',unit)
        .replaceAll(/(?:f6986f1a33ec7d7ce69215c6768e74c704317a777f2ebc1983d129b4e6835aae|dccc28a3f6eaab789d7484992520f2930e5862cc62de216710407c1ff02d4f14)/g,fakeHash);
      const file=join(modeHome,'install.sh');await writeFile(file,script);
      const env={...process.env,HOME:modeHome,PATH:`${tools}:${process.env.PATH}`,CFM_TEST_MODE:mode,CFM_TEST_CONF:conf,CFM_TEST_BIN:binary,CFM_TEST_UNIT:unit};
      const args=[file,`-id=${id}`,'-secret=test-secret','-url=https://test/update'];
      const run=(extra={})=>spawnSync('bash',args,{env:{...env,...extra},encoding:'utf8'});
      const state=async name=>(await readFile(join(modeHome,name),'utf8')).trim();
      let result=spawnSync('bash',['-n',file],{env,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      for (const failure of [{CFM_TEST_STATUS:'403'},{CFM_TEST_HTML:'1'}]) {
        result=run(failure);assert.notEqual(result.status,0);
        await assert.rejects(readFile(conf));
        await assert.rejects(readFile(join(modeHome,'service-state')));
      }
      // A failed first install must remove its newly created files and leave no autostart.
      result=run({CFM_TEST_FAIL:'enable'});assert.notEqual(result.status,0);
      for (const path of [conf,binary,unit]) await assert.rejects(readFile(path));
      assert.equal(await state('service-state'),'inactive');
      assert.equal(await state('enable-state'),'disabled');
      assert.match(result.stderr,/Restore result=1/);
      await rm(join(modeHome,'enable-failure-used'));

      // Both fresh install and replacement must undo the real Agent's disable step.
      for (let pass=0;pass<2;pass++) {
        result=run();assert.equal(result.status,0,result.stderr);
        assert.equal(await state('service-state'),'active');
        assert.equal(await state('enable-state'),'enabled');
        assert.match(result.stdout,/UnitFileState=enabled/);
      }
      const original=await Promise.all([conf,binary,unit].map(path=>readFile(path)));
      assert.match(original[0].toString(),/LATENCY_DETAIL="1"/);
      assert.match(original[0].toString(),/AUTO_UPDATE="0"/);
      // Failure recovery preserves all four combinations, rather than treating
      // "running" and "enabled at boot" as the same state.
      for (const active of ['active','inactive']) for (const enabled of ['enabled','disabled']) {
        await writeFile(join(modeHome,'service-state'),active);
        await writeFile(join(modeHome,'enable-state'),enabled);
        result=run({CFM_TEST_FAIL:'install'});assert.notEqual(result.status,0);
        assert.deepEqual(await Promise.all([conf,binary,unit].map(path=>readFile(path))),original);
        assert.equal(await state('service-state'),active);
        assert.equal(await state('enable-state'),enabled);
        assert.match(result.stderr,/Restore result=1/);
      }
      // An explicit enable failure OR a successful no-op must not claim success.
      for (const failure of ['enable','enable-noop']) {
        await writeFile(join(modeHome,'service-state'),'active');
        await writeFile(join(modeHome,'enable-state'),'enabled');
        result=run({CFM_TEST_FAIL:failure});assert.notEqual(result.status,0);
        assert.deepEqual(await Promise.all([conf,binary,unit].map(path=>readFile(path))),original);
        assert.equal(await state('service-state'),'active');
        assert.equal(await state('enable-state'),'enabled');
        assert.match(result.stderr,/Restore result=1/);
        await rm(join(modeHome,'enable-failure-used'));
      }
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
