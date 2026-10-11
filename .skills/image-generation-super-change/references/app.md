# App（手机 / Expo）端调用

> 本文件只补 App（Expo / React Native）端。Web / MiniProgram 用法见 `image-generations-api.md`、`image-edits-api.md`，不受影响。

## 与 Web 的关键差异

| 点 | Web 写法 | App 正确写法 |
|----|----------|--------------|
| 环境变量 | `import.meta.env.VITE_SUPABASE_URL`（`image-generations-api.md:231`、`image-edits-api.md:332`） | Hermes 无 `import.meta`；用 `import { supabase } from "@/client/supabase"` + `functions.invoke` |
| 展示生成图 | `atob` / `Blob` / `URL.createObjectURL`（`image-generations-api.md:254-264`、`image-edits-api.md:362-371`） | RN 无 `Blob`/`URL`；EF 返回**裸 base64**（无 `data:` 前缀），前端拼 `data:image/png;base64,` 后用 RN 内置 `Image` 直显 |
| 取参考图（图生图） | `FileReader` | RN 无 `FileReader`；`expo-image-picker` 取图 → `expo-image-manipulator` `base64:true` 直接产出裸 base64，正好对上 `image_edits` 的 `images[].b64_json` |

本接口**同步返回**（一次 `invoke` 即拿结果，无 task_id、无轮询）。

## 文生图（零装包）

EF `image-generations`，`body {prompt, size}`，返回 `data[].b64_json`（裸 base64，PNG）。size 仅支持 `1024x1024` / `1536x1024` / `1024x1536` / `2848x1152`。

```ts
import { Image } from "react-native";
import { supabase } from "@/client/supabase";

async function genImage(prompt: string) {
  const { data, error } = await supabase.functions.invoke("image-generations", {
    body: { prompt, size: "1024x1024" },
  });
  if (error) throw error;
  const b64 = data.data[0].b64_json;          // 裸 base64，无 data: 前缀
  return `data:image/png;base64,${b64}`;        // 拼前缀后给 RN Image
}

// <Image source={{ uri: dataUri }} style={{ width: 320, height: 320 }} />
```

## 图生图 / 编辑（需 expo-image-picker + expo-image-manipulator）

EF `image-edits`，`body {prompt, images: [{b64_json}], size}`，`images` 1~3 张、`images[0]` 必填，`b64_json` 为**裸 base64**。

装包（config-plugin 三步走，缺 app.json plugins 会触发 lint `no-undeclared-expo-plugin`）：
1. `npx expo install expo-image-picker expo-image-manipulator`
2. `app.json` 的 `plugins` 加 `"expo-image-picker"`，并写权限文案（`NSPhotoLibraryUsageDescription`）
3. 代码：

```ts
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { supabase } from "@/client/supabase";

async function pickBase64() {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error("需要相册权限");
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  if (res.canceled) return null;
  const out = await manipulateAsync(
    res.assets[0].uri,
    [{ resize: { width: 1024 } }],
    { compress: 0.8, format: SaveFormat.JPEG, base64: true }
  );
  return out.base64!;                            // 裸 base64，无 data: 前缀
}

async function editImage(prompt: string, b64: string) {
  const { data, error } = await supabase.functions.invoke("image-edits", {
    body: { prompt, images: [{ b64_json: b64 }], size: "1024x1024" },
  });
  if (error) throw error;
  return `data:image/png;base64,${data.data[0].b64_json}`;
}
```

## 注意

- 提示词先转英文再提交，出图质量更好（与 Web 一致）。
- 返回还含 `revised_prompt`，可展示给用户。
- 展示用 RN 内置 `Image` 或 `expo-image`（需装），**不要**用 `<img>` / `document.createElement`。


> 生成期执行 scripts/generate_image.py，失败不临时改写本页示例直连接口。固定请求参数与重试边界以 SKILL.md「生成期异常处理与固定调用」为准；成功 URL 响应保存已有图片，不重新生成。

## 模型显示名称

模型选择器及结果、历史记录使用固定名称：`图片-2` → `gpt-image-2`，`图片-2.5-flare` → `gpt-image-2.5-flare`。默认显示`图片-2`。界面仅展示中文标签，实际接口参数保留英文值；不得混用标签与值。完整规则见主文件的“用户可见模型名称（固定映射）”。
