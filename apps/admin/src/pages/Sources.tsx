export default function Sources() {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">源 (Sources)</h2>
      <div className="rounded border border-gray-200 bg-white p-6 text-sm text-gray-600">
        源列表功能将在 M2 接入 D1 的 source 表后实装。当前阶段请通过
        <code className="mx-1 rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">/upload</code>
        端点上传来创建源，并使用检索页验证。
      </div>
    </section>
  );
}