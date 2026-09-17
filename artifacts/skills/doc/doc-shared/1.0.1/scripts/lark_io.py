"""飞书 lark-cli 调用的共享实现（doc-publish 的 publish.py 与 export_cases_sheet.py 共用，2026-09-15 W3-H 收拢）。
规则来源 doc-shared/references/feishu.md §4–§5：
  - lark-cli 前删除 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY；account2 设 LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-account2，account1 清掉该变量。
  - 命令判定：在读命令白名单 READ_COMMANDS 里（docs +script 仅 --command parse）才算读，其余一律按写处理。
  - 写命令：跨进程全局写锁 ~/.cache/doc-publish/lark-write.lock 内串行、间隔 ≥ 1 秒（DOC_PUBLISH_WRITE_INTERVAL 只能调大），一律不自动重试；
    超时、无响应、限流或服务端报错都抛 Stop(7, uncertain_write=True)，由调用方先只读定位。
  - 读命令：遇限流或超时退避重试至多 READ_RETRIES 次。
  - 退出码 10 且响应 error.type=confirmation、subtype=confirmation_required：抛 Stop(10)，原样透传 action、risk、hint、argv，不追加确认 flag。
  - 文件夹落点：path 至少「客户或项目/子项目」两段，从根目录逐层只读解析；同名多个、近似名、token 与 path 不一致、缺一级文件夹（未允许新建）抛 Stop(5)。
本模块只调用 lark-cli，不读写运行目录。"""
import fcntl, glob, json, os, re, shutil, subprocess, time

EXIT_USAGE, EXIT_FOLDER, EXIT_LARK, EXIT_CONFIRM = 2, 5, 7, 10
PROXY_VARS = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')
PROFILES = ('account1', 'account2')
RATE_LIMIT_HINTS = ('frequency limit', 'resource contention', 'rate limit', 'too many requests', '99991400', '429')
WRITE_LOCK = os.path.expanduser('~/.cache/doc-publish/lark-write.lock')
MAX_PAGES = 50
READ_RETRIES = 3
# 读命令白名单（按 argv 前两段）；不在这里的一律按写命令处理。docs +script 另按 --command 判定（只有 parse 是只读预检）。
READ_COMMANDS = {('drive', 'files'), ('drive', '+list-comments'), ('docs', '+fetch'),
                 ('sheets', '+workbook-info'), ('sheets', '+sheet-info'), ('sheets', '+csv-get')}
READ_SCRIPT_COMMANDS = {'parse'}
UNCERTAIN = '写命令结果不确定，可能已写入飞书：先只读定位（drive files list 看目标文件夹 / docs +fetch 看文档）再决定，不要直接重跑写入'


class Stop(Exception):
    def __init__(self, code, step, message, **payload):
        super().__init__(message)
        self.code, self.step, self.message, self.payload = code, step, message, payload


def lark_env(profile):
    env = dict(os.environ)
    for k in list(env):
        if k.upper() in PROXY_VARS:
            env.pop(k)
    if profile == 'account2':
        env['LARKSUITE_CLI_CONFIG_DIR'] = os.path.expanduser('~/.lark-cli-account2')
    else:
        env.pop('LARKSUITE_CLI_CONFIG_DIR', None)
    return env


def find_lark(env):
    """feishu.md §4：PATH 前置最新 nvm bin（lark-cli 的 node 从这里来）。lark-cli 本身先按调用方原 PATH 解析成绝对路径，
    这样调用方（含自测）PATH 注入的 lark-cli 不会被 nvm 里的同名文件盖掉；原 PATH 找不到才用 nvm 里的。"""
    exe = shutil.which('lark-cli', path=env.get('PATH', ''))
    nvm = sorted(glob.glob(os.path.expanduser('~/.nvm/versions/node/v*/bin')), key=lambda x: [int(n) for n in re.findall(r'\d+', x)])
    if nvm:
        env['PATH'] = nvm[-1] + os.pathsep + env.get('PATH', '')
    if exe:
        return exe
    for d in reversed(nvm):
        if os.path.isfile(os.path.join(d, 'lark-cli')):
            return os.path.join(d, 'lark-cli')
    return None


def write_interval():
    """写命令最小间隔（feishu.md §5 ≥ 1 秒）；环境变量 DOC_PUBLISH_WRITE_INTERVAL 只能调大。"""
    try:
        v = float(os.environ.get('DOC_PUBLISH_WRITE_INTERVAL', '1.0'))
    except ValueError:
        v = 1.0
    return max(1.0, v)


def rate_limited(msg):
    return any(h in str(msg).lower() for h in RATE_LIMIT_HINTS)


def is_read(args):
    head = tuple(args[:2])
    if head == ('docs', '+script'):
        cmd = next((args[i + 1] for i in range(2, len(args) - 1) if args[i] == '--command'), None)
        return cmd in READ_SCRIPT_COMMANDS
    return head in READ_COMMANDS


def is_write(args):
    return not is_read(args)


def confirmation_error(returncode, bodies):
    """exit 10 确认门 envelope：退出码 10 且 stdout 或 stderr 的 JSON 里 error.type=confirmation、subtype=confirmation_required；否则 None。"""
    if returncode != 10:
        return None
    return next((b['error'] for b in bodies if isinstance(b.get('error'), dict)
                 and b['error'].get('type') == 'confirmation' and b['error'].get('subtype') == 'confirmation_required'), None)


class GlobalWriteLock:
    """跨运行目录、跨进程的飞书写锁：~/.cache/doc-publish/lark-write.lock（fcntl）。
    文件内容为 {"last_write": 墙钟秒}；持锁期间等到距上次写入 ≥ interval 秒，执行写命令，记下完成时间再释放。"""
    def __init__(self, interval):
        self.interval = interval

    def __enter__(self):
        os.makedirs(os.path.dirname(WRITE_LOCK), exist_ok=True)
        self.f = open(WRITE_LOCK, 'a+')
        fcntl.flock(self.f, fcntl.LOCK_EX)
        self.f.seek(0)
        try:
            last = float(json.loads(self.f.read() or '{}').get('last_write') or 0)
        except (ValueError, AttributeError):
            last = 0.0
        wait = last + self.interval - time.time()
        if wait > 0:
            time.sleep(wait)
        return self

    def __exit__(self, *exc):
        try:
            self.f.seek(0); self.f.truncate()
            self.f.write(json.dumps({'last_write': time.time(), 'pid': os.getpid()}))
            self.f.flush(); os.fsync(self.f.fileno())
        finally:
            fcntl.flock(self.f, fcntl.LOCK_UN)
            self.f.close()
        return False


class Lark:
    """lark-cli 调用器。run_dir 为子进程 cwd（@./ 相对路径据此解析）；apply 为假时遇写命令抛 Stop(2)（内部错误，dry-run 不得写）；
    uncertain 为写命令结果不确定时给调用方的只读定位提示。calls 记录每次调用 {step, args, exit}。"""
    def __init__(self, run_dir, profile, apply, uncertain=UNCERTAIN):
        self.run_dir, self.apply, self.uncertain = run_dir, apply, uncertain
        self.env = lark_env(profile)
        self.exe = find_lark(self.env)
        if not self.exe:
            raise Stop(EXIT_LARK, 'lark-cli', '找不到 lark-cli（PATH 与 ~/.nvm 下都没有）')
        self.calls = []
        self.interval = write_interval()

    is_write = staticmethod(is_write)

    def run_once(self, argv, step, args, write):
        try:
            if write:
                with GlobalWriteLock(self.interval):
                    r = subprocess.run(argv, capture_output=True, text=True, cwd=self.run_dir, env=self.env, timeout=300)
            else:
                r = subprocess.run(argv, capture_output=True, text=True, cwd=self.run_dir, env=self.env, timeout=300)
        except subprocess.TimeoutExpired:
            self.calls.append({'step': step, 'args': args, 'exit': 'timeout'})
            return None
        except OSError as ex:
            raise Stop(EXIT_LARK, step, f'lark-cli 无法执行：{ex}')
        self.calls.append({'step': step, 'args': args, 'exit': r.returncode})
        return r

    def call(self, args, step):
        """读命令遇到限流或超时退避重试；写命令一律不自动重试，结果不确定就退出 7。"""
        write = self.is_write(args)
        if write and not self.apply:
            raise Stop(EXIT_USAGE, step, f'内部错误：dry-run 试图执行写命令 {" ".join(args[:2])}')
        argv = [self.exe] + args + ['--format', 'json']
        for attempt in range(READ_RETRIES + 1):
            r = self.run_once(argv, step, args, write)
            if r is None:  # 超时
                if write:
                    raise Stop(EXIT_LARK, step, f'lark-cli 写命令超时（{" ".join(args[:2])}）：{self.uncertain}', uncertain_write=True)
                if attempt < READ_RETRIES:
                    time.sleep(2 ** attempt); continue
                raise Stop(EXIT_LARK, step, f'lark-cli 读命令超时（{" ".join(args[:2])}），已重试 {READ_RETRIES} 次')
            bodies = [b for b in (self.parse(r.stdout), self.parse(r.stderr)) if b]
            conf = confirmation_error(r.returncode, bodies)
            if conf:
                raise Stop(EXIT_CONFIRM, step, 'lark-cli 高风险确认门（exit 10）：已停止，把 action、risk 与参数给用户确认；本脚本不追加确认 flag',
                           confirmation_required=True, action=conf.get('action'), risk=conf.get('risk'), hint=conf.get('hint'),
                           lark_error=conf, argv=['lark-cli'] + args + ['--format', 'json'], uncertain_write=False)
            body = bodies[0] if bodies else None
            if r.returncode == 0 and body is not None and body.get('ok', True) is not False:
                return body
            eb = next((b for b in bodies if b.get('error')), None)
            msg = json.dumps(eb['error'], ensure_ascii=False) if eb else ((r.stderr or r.stdout)[-300:] or '无响应内容')
            limited = rate_limited(msg)
            if write:
                uncertain = limited or eb is None
                raise Stop(EXIT_LARK, step, f'lark-cli 写命令失败（退出码 {r.returncode}，{" ".join(args[:2])}）' + (f'：{self.uncertain}' if uncertain else '：服务端返回明确错误，未确认是否写入，先只读核对'),
                           lark_error=msg, uncertain_write=True, rate_limited=limited)
            if limited and attempt < READ_RETRIES:
                time.sleep(2 ** attempt); continue
            raise Stop(EXIT_LARK, step, f'lark-cli 失败（退出码 {r.returncode}）：{" ".join(args[:2])}', lark_error=msg, rate_limited=limited)

    @staticmethod
    def parse(s):
        s = (s or '').strip()
        if not s:
            return None
        try:
            d = json.loads(s)
            return d if isinstance(d, dict) else None
        except ValueError:
            i = s.find('{')
            try:
                d = json.loads(s[i:]) if i >= 0 else None
                return d if isinstance(d, dict) else None
            except ValueError:
                return None


def list_children(lark, token):
    """列直接子项（文件夹与文档），按 has_more 翻页（根目录也翻）；分页信息不完整时拒绝，不拿半张清单做判断。"""
    files, page, seen = [], '', set()
    where = token or '根目录'
    for _ in range(MAX_PAGES):
        params = {'folder_token': token, 'page_size': 200}
        if page:
            params['page_token'] = page
        d = lark.call(['drive', 'files', 'list', '--as', 'user', '--params', json.dumps(params, ensure_ascii=False)], 'folder-list')
        data = d.get('data') or {}
        files += data.get('files') or []
        if not data.get('has_more'):
            return files
        page = data.get('next_page_token') or data.get('page_token') or ''
        if not page or page in seen:
            raise Stop(EXIT_LARK, 'folder-list', f'{where} 的文件清单分页不完整（has_more 为真但没有新的 page_token），不能据此判断文件夹是否存在')
        seen.add(page)
    raise Stop(EXIT_LARK, 'folder-list', f'{where} 的文件清单超过 {MAX_PAGES} 页仍未结束')


def list_folder(lark, token):
    return [f for f in list_children(lark, token) if f.get('type') == 'folder']


def norm(s):
    return re.sub(r'\s+', '', str(s)).casefold()


def create_folder(lark, parent, seg, verb='发布'):
    """建一层文件夹，不自动重试。写命令失败（429、超时、无响应、响应缺字段或服务端报错）一律退出 7、不继续；
    退出前只读重列父目录，把找到的同名文件夹放进 located_folders 供编排层核对。核对后重跑，按 path 解析会直接用已存在的文件夹。"""
    args = ['drive', '+create-folder', '--as', 'user', '--name', seg] + (['--folder-token', parent] if parent else [])
    try:
        d = lark.call(args, 'folder-create')
        token = (d.get('data') or {}).get('folder_token')
        if not token:
            raise Stop(EXIT_LARK, 'folder-create', f'+create-folder 响应没有 data.folder_token：{lark.uncertain}', lark_response=json.dumps(d, ensure_ascii=False)[:200], uncertain_write=True)
        return token
    except Stop as ex:
        if ex.code != EXIT_LARK:
            raise
        payload = dict(ex.payload)
        payload['uncertain_write'] = True
        try:
            located = [{'name': f.get('name'), 'token': f.get('token'), 'url': f.get('url')} for f in list_folder(lark, parent) if f.get('name') == seg]
            note = f'只读重列父目录找到 {len(located)} 个同名文件夹（见 located_folders）'
        except Stop as ex2:
            located, note = None, f'只读重列父目录也失败（{ex2.message}）'
        payload.update(located_folders=located, parent_token=parent, folder_name=seg)
        raise Stop(EXIT_LARK, 'folder-create', f'+create-folder「{seg}」失败：{lark.uncertain}。不自动重试、不继续{verb}；{note}。核对后重跑{verb}（按 path 解析会直接使用已存在的文件夹；同名多个时会退出 5 交给用户选）', **payload)


def _cands(fs):
    return [{'name': f.get('name'), 'token': f.get('token'), 'url': f.get('url')} for f in fs]


def resolve_folder(lark, path, given, allow_create, allow_new_project, path_label='doc.json lark_folder.path', verb='发布', warnings=None):
    """返回 {token, path, created[], planned[], source}。path 至少两段（客户或项目/子项目），一律从根目录逐层只读解析；
    given（元数据里的 lark_folder.token）不为空时末级必须与之一致，且不新建。lark 为 None 时离线只做计划。
    归属拿不准抛 Stop(5)；path_label 与 verb 只影响提示文字；warnings 给了列表时离线且有 token 追加「未验证」警告。"""
    raw = (path or '').strip().strip('/')
    segs = [s.strip() for s in raw.split('/') if s.strip()]
    if len(segs) < 2:
        raise Stop(EXIT_FOLDER, 'folder', f'{path_label}「{raw}」不足「客户或项目/子项目」两段：归属拿不准，请编排层给选项问用户（不落根目录，也不落一级文件夹）',
                   options=[f'A 补全 {path_label} 为「客户或项目/子项目」', f'B 暂不{verb}'])
    path = '/'.join(segs)

    def plan_item(i, parent_token):
        return {'name': segs[i], 'parent_path': '/'.join(segs[:i]) or '(根目录)', 'parent_token': parent_token}

    if lark is None:
        if given:
            if warnings is not None:
                warnings.append('离线 dry-run：lark_folder.token 与 path 是否一致未验证')
            return {'token': given, 'path': path, 'created': [], 'planned': [], 'source': 'offline'}
        return {'token': None, 'path': path, 'created': [], 'source': 'offline',
                'planned': [plan_item(i, '' if i == 0 else f'<待建:{segs[i - 1]}>') for i in range(len(segs))]}
    parent, created, planned = '', [], []
    for i, seg in enumerate(segs):
        where = '/'.join(segs[:i]) or '(根目录)'
        if parent is None:  # 上一层还没建（dry-run），下面各层只能计划
            planned.append(plan_item(i, f'<待建:{segs[i - 1]}>')); continue
        folders = list_folder(lark, parent)
        exact = [f for f in folders if f.get('name') == seg]
        if len(exact) > 1:
            raise Stop(EXIT_FOLDER, 'folder', f'「{where}」下有 {len(exact)} 个同名文件夹「{seg}」：归属拿不准，请编排层问用户选哪个', candidates=_cands(exact))
        if exact:
            parent = exact[0]['token']; continue
        if given:
            raise Stop(EXIT_FOLDER, 'folder', f'lark_folder 给了 token，但按 path 从根目录解析时「{where}」下没有「{seg}」：token 与 path 对不上，请编排层问用户',
                       given_token=given, path=path)
        near = [f for f in folders if norm(f.get('name', '')) == norm(seg) or (norm(seg) and (norm(seg) in norm(f.get('name', '')) or norm(f.get('name', '')) in norm(seg)))]
        if near:
            raise Stop(EXIT_FOLDER, 'folder', f'「{where}」下没有「{seg}」，但有近似名文件夹：可能是同一客户或项目，请编排层问用户用哪个或确认新建', candidates=_cands(near))
        if i == 0 and not allow_new_project:
            raise Stop(EXIT_FOLDER, 'folder', f'根目录没有项目文件夹「{seg}」（新客户或新项目）：请编排层问用户确认后加 --allow-new-project-folder',
                       options=[f'A 新建「{path}」（加 --allow-new-project-folder）', 'B 改 path 指向已有文件夹', f'C 暂不{verb}'])
        if not allow_create:
            planned.append(plan_item(i, parent)); parent = None; continue
        token = create_folder(lark, parent, seg, verb)
        created.append({'name': seg, 'token': token, 'parent_path': where})
        parent = token
    if given and parent != given:
        raise Stop(EXIT_FOLDER, 'folder', f'lark_folder.token（{given}）与按 path「{path}」从根目录解析出的末级文件夹（{parent}）不一致：请编排层问用户以哪个为准',
                   given_token=given, resolved_token=parent, path=path)
    return {'token': parent, 'path': path, 'created': created, 'planned': planned, 'source': 'meta' if given else 'path'}
