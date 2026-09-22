# 门禁

`tests/gates/*.json` 各定义一条门禁。文件名等于 `id`。`scripts/run-gates.mjs` 读这个目录，用 `sh -c` 跑 `command`，按 `pass` 里的字面谓词判定。

谓词可以是：

- 退出码
- stdout 包含某行
- stdout 匹配某正则
- ratchet

ratchet 从输出里抽失败名。`parser` 为 `tap` 时抽 `not ok N - <name>`。`parser` 为 `acceptance` 时抽 `❌ <phase>`。抽到的失败名与基线文件比对。新失败与过期基线行都算 FAIL。基线为空时再套 `final` 谓词。

基线文件在 `tests/gates/baseline/`。首行是注释。其余每一行是一条已知失败。基线只能缩小。修掉一条失败就删掉对应那一行。不要加行。不要重排留下的行。

本树不是叠好的栈顶。仍红的行必须留下。

## 怎么加一条门禁

1. 在 `tests/gates/` 新建 `<id>.json`。
2. `id` 必须等于文件名去掉 `.json`。
3. 写 `group`、`command`、`pass`。需要浏览器的加 `"requires": ["playwright"]`。
4. 若起步时已有已知失败，写 `tests/gates/baseline/<id>.txt`，并在 `pass.ratchet` 里指向它。
5. 跑 `node scripts/run-gates.mjs --id <id>`。新失败必须进基线，否则门禁红。
6. 跑 `node scripts/run-gates.mjs --list --json` 确认新 id 出现。

## 怎么缩小基线

1. 先让对应测试由红转绿。
2. 从基线文件删掉那一行。只删真正变绿或关掉的行。
3. 再跑 `node scripts/run-gates.mjs --id <id>`。若出现 `stale baseline line, delete it`，说明删对了还漏了一行，或删了仍红的行。
4. 不要用 `--write-baseline` 把仍红的失败冲掉。

## 常用命令

```
node scripts/run-gates.mjs --list
node scripts/run-gates.mjs --list --json
node scripts/run-gates.mjs --without playwright
DISTILLY_PLAYWRIGHT_ROOT=/tmp/pw-root node scripts/run-gates.mjs --requires playwright
node scripts/run-gates.mjs --id audit-tests
node scripts/check-entry-surface.mjs --baseline tests/gates/baseline/entry-surface.txt
```

Node 20 与 Node 22 都要跑 `--without playwright`。playwright 组只在 Node 22 跑。仓库里不执行 `npm install`。
