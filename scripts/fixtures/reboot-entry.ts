// 测试 fixture：模拟生产入口（tsx 运行 TS、使用 @/ 路径别名）。
// 由 smoke-admin-reboot.ts 作为「被 /reboot 拉起的新进程」启动并校验输出。
import { botConfig } from '@/config';

console.log(`FIXTURE_STARTED pid=${process.pid}`);
console.log(`FIXTURE_ALIAS_OK githubPort=${botConfig.githubPort}`);
console.log(`FIXTURE_EXECARGV=${JSON.stringify(process.execArgv)}`);
console.log(`FIXTURE_START_DELAY=${process.env.QQBOT_START_DELAY_MS ?? ''}`);

// 保持存活，等待父进程健康检查观察窗口结束
setTimeout(() => {
  console.log('FIXTURE_DONE');
  process.exit(0);
}, 1500);
