/**
 * app-server 时间戳的单位归一。
 *
 * `thread/list` 返回的 `createdAt` / `updatedAt` 是**秒**级 Unix 时间戳（实测 codex 0.153.4），
 * 而 CAR 内部一律用毫秒。混用会让「和 Date.now() 比大小」这类判断差出三个数量级 ——
 * 会话自动发现就曾因此把每一条线程都判成「陈旧」，静默失效且不报错。
 *
 * 按量级识别：2001 年之后的毫秒时间戳都大于 1e12，秒级则远小于它。
 */
export function toMillis(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v < 1e12 ? v * 1000 : v;
}
