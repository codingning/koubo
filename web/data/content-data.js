window.KOUBO_DATA = {
  project: {
    name: "Codex / Agent / Skill 实测工作台",
    subtitle: "真实跑通 · 可复用资产 · 明确边界",
    positioning: "面向开发者与进阶用户，真实跑通Codex、Agent、Skill和开源组件，交付提示词、工作流图、清单与模板。",
    phase: "开放选题池 · 不设固定天数和每日目标",
    autoPublish: false,
    updatedAt: "2026-07-29"
  },
  contentItems: [
    {
      id: "developer-workflow-start",
      kind: "developer",
      date: "2026-07-29",
      day: "新定位",
      column: "Codex / Agent / Skill 实测",
      status: "待选题",
      badge: "当前定位",
      contentRevision: "2026-07-29-developer-proof-first",
      sourcePackagePath: "F:\\code\\koubo\\docs\\CREATOR_PROFILE.md",
      sourcePackageHref: "../docs/CREATOR_PROFILE.md",
      contentFolderPath: "F:\\code\\koubo\\docs",
      durationFull: "按证据密度决定",
      durationShort: "可选精简版",
      mainTopic: "选择一个已经跑通、能交付资产的开发者问题",
      shortTopic: "等待实测选题",
      hook: "先展示运行结果、失败画面或资源文件，再解释怎么复用。",
      audienceBenefit: "拿走一个经过真实验证的提示词、工作流图、清单或模板。",
      engagement: {
        audienceMirror: "你已经会用AI写代码，但Skill、Agent和工作流一多，就很难判断什么值得装、怎样组合和怎样验收。",
        commentPrompt: "你更需要可安装Skill、Agent工作流图，还是开源项目审计清单？",
        followPromise: "下一条只在真实证据和资源准备完成后，验证一个明确分支。",
        viewerTask: "先写下你当前最想减少的一次重复操作或一次失败检查。",
        primaryClose: "选定真实问题并跑通后，我会把对应模板整理成可领取版本。"
      },
      structureDesign: {
        archetype: "quick-proof",
        selectionReason: "新定位先用最短路径证明结果和资源价值。",
        coreQuestion: "哪一个开发者问题值得先做真实实测？",
        hookConflict: "会用AI不等于已经拥有稳定工作流。",
        saveableFramework: [
          { label: "问题", action: "锁定一个具体失败或重复劳动", expectedSignal: "能用一句话描述输入和期望结果" },
          { label: "实测", action: "完成安装、运行和失败验证", expectedSignal: "保存真实输出、错误或前后差异" },
          { label: "交付", action: "整理提示词、流程图、清单或模板", expectedSignal: "资源文件有版本和适用范围" }
        ],
        personalEvidenceRole: "本地项目只负责提供真实运行证据。",
        personalVariation: "优先验证Windows、Codex和本地Agent工作流。",
        boundary: "当前还没有锁定第一条新选题，不应直接拍摄或发布。",
        payoff: "观众能判断是否值得复用，并拿到文件化资产。"
      },
      storyPosition: {
        problem: "旧内容围绕个人成长和项目进度，开发者无法立即拿走可复用成果。",
        current: "已取消30天规划，改为Codex、Agent、Skill实测与资源交付。",
        nextVerification: "从三个开放选题池中选择一个有完整证据和资产的问题。"
      },
      fullSegments: [
        { time: "定位说明", label: "暂不拍摄", tone: "直接", text: "当前没有锁定正式选题。请先在上方填写一个Codex、Agent、Skill或开源项目问题，以及真实运行证据；只有资源文件和验证结果都准备好后才生成口播。" }
      ],
      shortScript: "",
      evidence: [
        { name: "新创作者定位", proof: "已取消30天和泛成长主线", path: "../docs/CREATOR_PROFILE.md", public: true },
        { name: "新内容工作流", proof: "按证据和资产选择题目，不按日期凑内容", path: "../docs/WORKFLOW.md", public: true }
      ],
      risks: [
        { text: "未锁定真实问题和证据前不进入拍摄", done: true },
        { text: "资源文件必须真实存在并标记版本", done: false },
        { text: "微信群导流方式需核对当前平台规则", done: false }
      ],
      sourceFiles: [
        { label: "创作者定位", path: "../docs/CREATOR_PROFILE.md" },
        { label: "内容工作流", path: "../docs/WORKFLOW.md" },
        { label: "证据来源矩阵", path: "../docs/SOURCE_MATRIX.md" }
      ]
    },
    {
      id: "growth-day-1",
      kind: "legacy",
      date: "2026-07-17",
      day: "Day 1",
      column: "历史：普通人的AI行动实验",
      status: "已废止定位",
      badge: "历史证据",
      contentRevision: "2026-07-19-spoken-problem-solving",
      sourcePackagePath: "E:\\ai\\koubo\\runs\\2026-07-17\\growth\\02_main_package.md",
      sourcePackageHref: "../runs/2026-07-17/growth/02_main_package.md",
      contentFolderPath: "E:\\ai\\koubo\\runs\\2026-07-17\\growth",
      durationFull: "约85秒",
      durationShort: "约60秒",
      mainTopic: "我做了AI口播工作台，却一直没拍第一条视频",
      shortTopic: "工具齐了，还没开始",
      hook: "大家好，我是___。这是我第一次认真面对镜头拍视频。",
      audienceBenefit: "你缺的可能不是更多方法，而是一个允许自己做得很差的30秒开始。",
      engagement: {
        audienceMirror: "你可能也收藏了很多教程、研究了很多工具，却总觉得还要再准备一点才配开始。",
        commentPrompt: "如果你在学AI、做开发，或者工作和生活里有一件事一直想解决，把它具体地告诉我。",
        followPromise: "下一条，我会把这次原片交给工作台，看看它能不能把我的停顿、卡壳和字幕真正处理好。",
        viewerTask: "你也可以先挑一件最想解决的小事。"
      },
      creativeTone: {
        humorBeat: "我把“开始”准备得特别充分，充分到一直没开始。",
        trendMeme: {
          id: "douyin-xuejie-xian-zuoqilai",
          name: "学姐先做起来",
          adaptedLine: "学姐都说了，先做起来嘛。",
          placement: "开头观众代入后",
          sourceUrl: "https://www.douyin.com/jingxuan/search/%E5%AD%A6%E5%A7%90%E5%85%88%E5%81%9A%E8%B5%B7%E6%9D%A5%E5%98%9B?aid=40989543-e5a4-4331-a554-8069658ca90f&modal_id=7656425171091354034&type=general"
        }
      },
      actionExperiment: {
        oldState: "每天看AI、收藏工具、研究短视频，还做了自己的AI口播工作台，但没有拍出第一条真人视频。",
        currentConflict: "工具越来越完整，真正的开始却一直被继续准备推迟。",
        realAction: "停止继续优化工作流，先把第一遍真人口播录完。",
        resultEvidence: "第一遍拍摄原片、卡壳次数、拍摄耗时和最终上传到工作台的任务记录。",
        insight: "缺的不是工具，而是允许第一遍不专业、不完美。",
        viewerTask: "你也可以先挑一件最想解决的小事。"
      },
      storyPosition: {
        yesterday: "每天了解AI、收藏工具、研究短视频，并做了自己的AI口播工作台，但个人账号仍没有第一条真人视频。",
        today: "不再继续把开发工作流当成开始，先完成第一遍真人口播拍摄。",
        tomorrow: "把真实原片上传到工作台，验证停顿、卡壳和字幕能否被有效处理。"
      },
      progress: [
        "已完成自己的AI口播工作台，并持续用真实拍摄验证",
        "个人AI成长账号尚未发布第一条真人出镜视频",
        "已确认核心受众是“知道很多、收藏很多，但迟迟没有开始的人”",
        "把账号主线收敛为口播工作台优化和真实问题AI共创",
        "第一条视频本身就是停止继续准备、按下录制键的真实行动"
      ],
      candidates: [
        { type: "行动冲突型", topic: "我做了AI口播工作台，却一直没拍第一条视频", score: 97.0, result: "主选题" },
        { type: "观众共鸣型", topic: "每天看AI、收藏教程，为什么还是没有真正开始", score: 95.0, result: "备选1" },
        { type: "热点梗型", topic: "学姐都说先做起来，我却还在优化工作台", score: 92.0, result: "备选2" },
        { type: "真实拍摄型", topic: "第一条视频允许自己拍得很差", score: 91.0, result: "后续可用" },
        { type: "职业自由型", topic: "为什么我先不谈变现，只练习从知道到做到", score: 86.0, result: "后续可用" }
      ],
      fullSegments: [
        {
          time: "0—8秒",
          label: "问候 + 自我介绍",
          tone: "自然，像第一次认识",
          text: "大家好，我是___。这是我第一次认真面对镜头拍视频。"
        },
        {
          time: "8—24秒",
          label: "真实旧状态",
          tone: "自嘲，不卖惨",
          text: "我平时一直在研究AI，也给自己做了一个AI口播工作台。写稿、剪辑、字幕，它都能帮上一点忙。挺尴尬的是，工具越做越多，我的第一条视频却一直没拍。"
        },
        {
          time: "24—36秒",
          label: "当前冲突",
          tone: "用反差逗一下",
          text: "我把“开始”准备得特别充分，充分到一直没开始。学姐都说了，先做起来嘛，所以今天不等准备好了，先把第一遍拍完。"
        },
        {
          time: "36—54秒",
          label: "接下来真正要做的事",
          tone: "具体，不喊口号",
          text: "接下来我会一边用真实拍摄继续优化这个工作台，一边做一些真正能解决具体问题的AI小项目。不是只介绍工具，而是看看它最后到底能不能帮到人。"
        },
        {
          time: "54—72秒",
          label: "邀请一起共创",
          tone: "真诚，像在聊天",
          text: "如果你在学AI、做开发，或者工作和生活里有一件事一直想解决，把它具体地告诉我。你也可以先挑一件最想解决的小事。我们挑真实的问题，一起试着用AI把它做出来，也看看AI到底能帮到哪一步。"
        },
        {
          time: "结尾",
          label: "下一次真实验证",
          tone: "明确、利落",
          text: "下一条，我会把这次原片交给工作台，看看它能不能把我的停顿、卡壳和字幕真正处理好。"
        }
      ],
      shortScript: "大家好，我是___。这是我第一次认真面对镜头拍视频。我一直在研究AI，也给自己做了一个AI口播工作台。写稿、剪辑、字幕都能帮上一点，唯一没有自动的，是我按下录制键。我把“开始”准备得特别充分，充分到一直没开始。学姐都说了，先做起来嘛，所以今天先把第一遍拍完。接下来我会继续优化这个工作台，也会做真正能解决具体问题的AI小项目。如果你在学AI、做开发，或者工作和生活里有一件事一直想解决，把它具体地告诉我。你也可以先挑一件最想解决的小事。我们一起试着用AI把它做出来。下一条，我会把这次原片交给工作台，看看它能不能把我的停顿、卡壳和字幕真正处理好。",
      titles: [
        { type: "核心冲突型", text: "我做了AI口播工作台，却一直没拍第一条" },
        { type: "观众共鸣型", text: "每天看AI，却迟迟没有真正开始" },
        { type: "热点梗型", text: "学姐都说先做起来，我还在优化工作台" },
        { type: "反差型", text: "写稿剪辑都能自动，按录制键不能" },
        { type: "行动型", text: "别再等准备好了，先录30秒" }
      ],
      covers: [
        {
          id: "cover-a",
          name: "方案A · 推荐",
          copy: "工具齐了 还没开始",
          expression: "无奈笑，手指向口播工作台界面",
          composition: "人物左侧，右侧工作台界面，底部一个没按下的红色录制键",
          color: "深蓝 + 录制键红",
          reason: "真实反差最强，不懂技术的人也能一眼看懂。"
        },
        {
          id: "cover-b",
          name: "方案B · 热梗",
          copy: "学姐：先做起来嘛",
          expression: "被点名后的尴尬笑",
          composition: "左侧工作台和录制键，右侧大字“先做起来”",
          color: "明黄 + 黑色",
          reason: "轻松、有当下语感，但发布前需确认热梗仍在有效期。"
        },
        {
          id: "cover-c",
          name: "方案C · 行动",
          copy: "先录30秒",
          expression: "手放在录制键上",
          composition: "手机录制界面占主体，角落写“不用发布”",
          color: "白色 + 红色",
          reason: "给观众的动作最直接，收藏价值高。"
        }
      ],
      shooting: {
        tone: "轻松、自嘲、像和同样迟迟没开始的朋友说话；不要项目汇报腔。",
        speed: "230—250字/分钟，热梗和反差句后留半秒。",
        framing: "开头近景；口播工作台界面做快速画中画；按录制键时给手部特写。",
        gestures: "自我介绍时轻点自己；说“唯一没有自动”时指向自己；邀请大家提问题时自然摊手，不逐项比手势。",
        highlights: ["我是___", "AI口播工作台", "第一条视频一直没拍", "充分到一直没开始", "解决一个具体问题", "把问题告诉我"],
        broll: [
          "手机里收藏的AI教程或工具列表，注意脱敏",
          "AI口播工作台的提词、剪辑、字幕界面快速闪过",
          "鼠标继续修改代码与手机录制键的反差切换",
          "第一遍拍摄卡壳片段，不必剪得完美",
          "把原片上传口播工作台的真实画面",
          "评论区真实问题被整理成待验证清单的画面"
        ]
      },
      publish: {
        douyin: `学姐都说了，先做起来嘛。

大家好，我是___。我给自己做了一个AI口播工作台，写稿、剪辑、字幕都能帮上一点，唯一没自动的是我按下录制键。

所以这条不追求专业，先让第一遍存在。接下来我会继续优化这个工作台，也会做真正能解决具体问题的AI小项目。

你在学AI、做开发，或者工作和生活里有什么具体问题想解决？把它告诉我，我们一起试着用AI做出来。

#先做起来 #学姐先做起来 #从知道到做到 #普通人的AI行动实验 #第一条视频`,
        xiaohongshu: `大家好，我是___。我研究AI、工具和短视频很久，也给自己做了一个AI口播工作台。

听起来像是准备充分，实际上充分到一条真人视频都没拍。

最近“学姐先做起来”这个梗特别适合我：学姐都说了，先做起来嘛。

所以今天不再继续优化工具，先把第一遍拍完。AI能帮我写稿、剪辑、加字幕，但不能替我面对镜头。

接下来我会一边用真实拍摄优化这个工作台，一边开发真正能解决具体问题的AI小项目。

如果你在学AI、做开发，或者工作和生活里有一件事一直想解决，把它具体地写下来。我们挑真实的问题，一起试着用AI把它做出来。

下一条先看这次原片交给工作台后，停顿、卡壳和字幕能不能被真正处理好。

#从知道到做到 #普通人的AI行动实验 #先做起来 #第一次拍视频 #AI实践`,
        weibo: `学姐都说了：先做起来嘛。

大家好，我是___。我给自己做了一个AI口播工作台，写稿、剪辑、字幕都能帮上一点，唯一没自动的是按下录制键。

所以这条先不追求专业，先拍完。接下来我会继续优化工作台，也会做真正能解决具体问题的AI项目。

你在学AI、做开发，或者工作和生活里有什么具体问题想解决？把它告诉我，我们一起试着用AI做出来。`
      },
      evidence: [
        { name: "AI口播工作台", proof: "工具已经具备，但真人内容仍未开始", path: "", public: "需用脱敏截图" },
        { name: "创作者定位", proof: "受众和“从知道到做到”主线已固化", path: "../docs/CREATOR_PROFILE.md", public: true },
        { name: "今日真实进展", proof: "用户反馈、定位修正和第一条行动均有记录", path: "../runs/2026-07-17/growth/00_daily_progress.md", public: true },
        { name: "学姐先做起来热梗", proof: "公开话题与“停止准备、先开始”语境相关", path: "https://www.douyin.com/jingxuan/search/%E5%AD%A6%E5%A7%90%E5%85%88%E5%81%9A%E8%B5%B7%E6%9D%A5%E5%98%9B?aid=40989543-e5a4-4331-a554-8069658ca90f&modal_id=7656425171091354034&type=general", public: true },
        { name: "第一遍真人原片", proof: "已经按下录制键", path: "", public: "拍摄后由本人确认" }
      ],
      risks: [
        { text: "不把计划中的拍摄、发布、播放量或涨粉写成已完成结果", done: true },
        { text: "不虚构评论、投票结果或粉丝问题", done: true },
        { text: "热梗只使用短语和语境，不搬运完整视频、不假装认识原博主", done: true },
        { text: "不在口播中写未经稳定核验的热度数字", done: true },
        { text: "语气保持轻松口语化，不讲成工具功能汇报或成功学课程", done: true },
        { text: "发布前确认工作台截图全部脱敏", done: false },
        { text: "发布前确认第一遍卡壳片段可以公开", done: false },
        { text: "发布前再次确认“学姐先做起来”仍在有效语境中", done: false }
      ],
      sourceFiles: [
        { label: "今日真实进展", path: "../runs/2026-07-17/growth/00_daily_progress.md" },
        { label: "候选评分", path: "../runs/2026-07-17/growth/01_candidates.md" },
        { label: "完整素材包", path: "../runs/2026-07-17/growth/02_main_package.md" },
        { label: "热点与资料来源", path: "../runs/2026-07-17/growth/03_sources.csv" },
        { label: "人工审核清单", path: "../runs/2026-07-17/growth/04_review_checklist.md" },
        { label: "内容风格规则", path: "../config/content_style.json" },
        { label: "已核对热梗池", path: "../config/meme_pool.json" }
      ]

    },
    {
      id: "legacy-day-1",
      kind: "legacy",
      date: "2026-07-15",
      day: "旧Day 1",
      column: "综合热点口播",
      status: "旧定位基线",
      badge: "保留对照",
      sourcePackagePath: "F:\\code\\koubo\\runs\\2026-07-15\\02_main_package.md",
      sourcePackageHref: "../runs/2026-07-15/02_main_package.md",
      contentFolderPath: "F:\\code\\koubo\\runs\\2026-07-15",
      durationFull: "约82秒",
      durationShort: "约43秒",
      mainTopic: "新能源车‘平均车龄1.8年’为什么不是‘车只能开1.8年’",
      shortTopic: "1.8年≠车寿命",
      hook: "一辆新能源车，平均只开1.8年？不是。这句话，把一个统计数字看反了。",
      audienceBenefit: "看到平均数时先问清统计对象、分母和时间结构。",
      legacyPath: "../runs/2026-07-15/02_main_package.md"
    }
  ],
  experiments: [
    {
      type: "Skill真实跑通",
      question: "这个Skill解决什么问题，怎样安装、调用和验证？",
      evidence: "官方来源、固定版本、真实运行结果和失败边界。",
      asset: "提示词 / 配置模板 / 安装清单"
    },
    {
      type: "Agent工作流拆解",
      question: "输入、角色、工具、人工门和失败恢复怎样连接？",
      evidence: "流程图、一次完整运行、错误与回滚记录。",
      asset: "工作流图 / 执行提示词 / 验收清单"
    },
    {
      type: "开源项目审计",
      question: "是否值得装，适合谁，不适合谁？",
      evidence: "源码关系、许可证、安全、维护和Windows试用。",
      asset: "审计表 / 安装步骤 / 替代方案清单"
    }
  ]
};
