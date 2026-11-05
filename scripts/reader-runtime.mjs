import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readerModule from '../src/python-reader.js';
const { pythonExecutable } = readerModule;

const root = fileURLToPath(new URL('../', import.meta.url));
const absolute = path => fileURLToPath(new URL('../' + path, import.meta.url));
const localPython = absolute(process.platform === 'win32' ? '.venv-reader/Scripts/python.exe' : '.venv-reader/bin/python');
const env = {};
for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
env.PYTHONNOUSERSITE = '1';
function run(program, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let output = '';
    if (capture) {
      const collect = chunk => { output = (output + chunk.toString()).slice(-8192); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('[READER_SETUP_TIMEOUT] تجاوز فحص/إعداد القارئ المهلة. راجع اتصال الاستضافة وصلاحيات التثبيت.'));
    }, capture ? 20000 : 180000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('[READER_PYTHON_MISSING] تعذر تشغيل Python. وفّر Python 3.10+ أو صحح PYTHON_BIN.'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve({ code, output });
      else reject(new Error('[READER_SETUP_FAILED] فشل إعداد/فحص القارئ. راجع الخطأ أعلاه؛ تحتاج الاستضافة Python وvenv/pip وصلاحية تثبيت الحزم.'));
    });
  });
}
async function diagnose(python) {
  console.log(`[READER_PYTHON] ${python}`);
  const result = await run(python, [absolute('reader/check.py')], { capture: true, allowFailure: true });
  if (result.output.trim()) console.log(result.output.trim());
  return result;
}
async function setup(python) {
  // A supplied interpreter is treated as an owner-managed virtual environment.
  if (!process.env.PYTHON_BIN?.trim()) {
    if (!existsSync(localPython)) await run(python, ['-m', 'venv', absolute('.venv-reader')]);
    python = localPython;
  }
  console.log(`[READER_INSTALL] ${python}`);
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', absolute('requirements-reader.txt')]);
  return python;
}
const mode = process.argv[2] || 'check';
try {
  let python = pythonExecutable(process.env.PYTHON_BIN?.trim());
  if (mode === 'ensure') {
    const source = 'discord.py-self';
    if (source !== 'discord.py-self' || !process.env.READER_TOKEN?.trim()) {
      console.log('[READER_SETUP_SKIPPED] المصدر الخارجي أو عدم إعداد القارئ لا يحتاج تثبيت Python.');
    } else {
      const first = await diagnose(python);
      if (first.code !== 0) {
        if (first.output.includes('"READER_PYTHON_VERSION"')) throw new Error('[READER_PYTHON_VERSION] حدّث مفسر الاستضافة إلى Python 3.10+ قبل تثبيت الحزمة.');
        console.log('[READER_AUTO_SETUP] محاولة واحدة لتثبيت المتطلبات؛ لا يتم تسجيل دخول الحساب أثناء الإعداد.');
        python = await setup(python);
        const final = await diagnose(python);
        if (final.code !== 0) throw new Error('[READER_SETUP_FAILED] الفحص لم ينجح بعد التثبيت. إن ضبطت PYTHON_BIN فتأكد أنه بيئة مخصصة للقارئ؛ اتركه فارغًا لاستخدام بيئة المشروع.');
      }
    }
  } else if (mode === 'test') {
    await run(python, ['-m', 'unittest', 'discover', '-s', absolute('reader'), '-p', 'test_*.py']);
  } else if (['setup', 'check'].includes(mode)) {
    if (mode === 'setup') python = await setup(python);
    const result = await diagnose(python);
    if (result.code !== 0) throw new Error('[READER_CHECK_FAILED] راجع التشخيص أعلاه وإعداد PYTHON_BIN.');
  } else throw new Error('استخدم setup أو check أو test أو ensure.');
} catch (error) {
  console.error(error.message);
  // A failed dependency setup must not take down the independent Snow/ping bot.
  // The worker will report its precise dependency error on a profile command.
  if (mode === 'ensure') console.warn('[READER_SETUP_UNAVAILABLE] سيستمر البوت بأوامر سنو وping. لم ينجح إعداد القارئ.');
  else process.exitCode = 1;
}
