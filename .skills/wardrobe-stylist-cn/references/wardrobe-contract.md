# 衣橱数据契约
核心对象：profile、item、look、schedule、wearLog、trip、shoppingGap。
每个 look 只能引用现有 itemIds。item 包含类别、颜色、材质、季节、正式度、状态、图片和 confirmed。图片识别标签在确认前 confirmed=false。
删除单品时标记依赖穿搭需修复；删除图片时同步删除 Storage 对象和数据库引用。洗护状态为 clean、worn、laundry、unavailable。
