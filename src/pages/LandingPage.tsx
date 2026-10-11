import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clock, AlertTriangle, ShieldAlert, Users, ChevronRight, CheckCircle2 } from 'lucide-react';

export const LandingPage: React.FC = () => {
  // 升级链路：一次渲染一张、滑动/入口切换
  const [escStep, setEscStep] = useState<number>(0);

  // 三级响应链数据（L0 是提醒本身不计级；漏服后 10 分钟/30 分钟/1 小时逐级升级）
  const ESC_STEPS = [
    {
      time: '漏服后 · 每 10 分钟',
      title: '第 1 级 · 提醒患者本人',
      body: '漏服发生，系统每 10 分钟向患者端推送一次打卡提醒，可「已服用 / 稍后提醒 / 跳过」。',
    },
    {
      time: '30 分钟无响应',
      title: '第 2 级 · 请家属协助',
      body: '家属端收到协助任务，查看照护对象今日状态，可代打卡、电话联系，或反馈仍无响应。',
    },
    {
      time: '1 小时无响应',
      title: '第 3 级 · 医护端介入',
      body: '漏服事件升级到医护工作台预警中心，护士准备电话随访，录入处置结论后闭环解除。',
    },
  ];

  return (
    <div className="bg-background text-foreground antialiased min-h-screen flex flex-col w-full max-w-full overflow-x-hidden">
      {/* 顶栏 */}
      <header className="sticky top-0 z-50 bg-background/85 backdrop-blur border-b border-border">
        <div className="container flex items-center gap-5 py-3.5">
          <a href="#hero" className="flex items-center gap-2.5 shrink-0">
            <span className="w-9 h-9 rounded-full bg-primary text-primary-foreground font-black grid place-items-center text-lg">
              愈
            </span>
            <span className="font-black text-lg tracking-wide">愈见 CareLoop</span>
          </a>
          <div className="hidden md:flex items-center gap-7 text-sm ml-4 text-muted-foreground font-medium">
            <a href="#loop" className="hover:text-foreground transition-colors">
              照护闭环
            </a>
            <a href="#showcase" className="hover:text-foreground transition-colors">
              产品实景
            </a>
            <a href="#escalation" className="hover:text-foreground transition-colors">
              升级链路
            </a>
            <a href="#triage" className="hover:text-foreground transition-colors">
              三级分诊
            </a>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/login"
              className="rounded-full border border-border text-sm font-medium px-4 py-2 hover:border-primary/50 transition-all"
            >
              登录
            </Link>
            <Link
              to="/login"
              className="rounded-full bg-primary text-primary-foreground text-sm font-medium px-5 py-2 hover:brightness-95 transition-all shadow-sm"
            >
              开始使用
            </Link>
          </div>
        </div>
        {/* 首屏合规提示条（L1：截图可见合规） */}
        <div className="border-t border-border bg-triage-blue-bg">
          <p className="container py-2 text-center text-xs font-medium text-triage-blue">
            本内容不构成医疗诊断，请遵医嘱 · 演示数据均为虚构脱敏
          </p>
        </div>
      </header>

      <main className="flex-1 w-full max-w-full overflow-x-hidden">
        {/* Section 0: 产品定位介绍屏（「愈见」显著放大） */}
        <section id="positioning" className="relative w-full max-w-full overflow-hidden">
          <div className="container py-20 md:py-28 text-center">
            <p className="sig-eyebrow justify-center">出院患者全周期照护助手</p>
            <h1 className="mt-6 font-black leading-[1.1] tracking-tight text-[clamp(3.2rem,11vw,7.5rem)]">
              <span className="bg-gradient-to-r from-primary via-sig-rose to-primary bg-clip-text text-transparent">愈见</span>
              <span className="ml-4 align-middle text-[clamp(1.3rem,3.5vw,2.4rem)] font-bold text-muted-foreground">CareLoop</span>
            </h1>
            <p className="mt-6 text-[16px] md:text-lg leading-[1.9] text-muted-foreground max-w-2xl mx-auto">
              一份出院小结，连接患者、家属与医护三方——AI 结构化生成用药与随访计划，到点提醒、逐级升级、症状分诊、预警处置，把出院后的每一天都装进闭环。
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                to="/login?role=patient"
                className="rounded-full bg-primary text-primary-foreground font-medium px-7 py-3 text-[15px] hover:brightness-95 transition-all shadow-sm"
              >
                患者端 · 开始使用
              </Link>
              <Link
                to="/login?role=family"
                className="rounded-full border border-border font-medium px-7 py-3 text-[15px] hover:border-primary/50 transition-colors"
              >
                家属端 · 照护协同
              </Link>
              <Link
                to="/login?role=clinician"
                className="rounded-full border border-border font-medium px-7 py-3 text-[15px] hover:border-primary/50 transition-colors"
              >
                医护端 · 登录工作台
              </Link>
            </div>
          </div>
        </section>

        {/* Section 1: Hero (Split Screen) */}
        <section id="hero" className="relative w-full max-w-full overflow-hidden">
          <div className="grid md:grid-cols-3 min-h-[34rem] md:min-h-[38rem]">
            {/* 左：患者端 */}
            <div className="sig-soft-bg p-7 md:p-10 flex flex-col animate-curtain-left">
              <p className="sig-eyebrow">患者端 · 移动优先</p>
              <h2 className="mt-4 font-black text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.3]">
                看得懂的
                <br />
                康复计划
              </h2>
              <p className="mt-4 text-[15px] leading-[1.85] text-foreground/70">
                出院小结拍照上传，AI 生成用药与随访计划；到点提醒、一键打卡、随问随答。
              </p>
              <p className="mt-3 text-[13px] leading-[1.7] text-muted-foreground">
                患者一个人也能安心用：看清单、打勾、有疑问问助手。
              </p>
              <div className="mt-auto pt-6 flex justify-center md:justify-start">
                <div className="sig-phone">
                  <div className="sig-screen">
                    <div className="bg-primary/90 px-4 py-2.5 flex items-center justify-between">
                      <p className="text-[13px] font-medium text-primary-foreground">愈见 · 今日</p>
                      <p className="text-[12px] sig-num text-primary-foreground/80">术后第 9 天</p>
                    </div>
                    <div className="p-4 space-y-3">
                      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
                        <p className="text-[12px] text-muted-foreground">今晨用药 · 08:00 · 已确认</p>
                        <p className="text-[14px] font-black mt-1">硫酸氢氯吡格雷片 75mg</p>
                        <div className="mt-2.5 flex gap-2">
                          <span className="text-[12px] font-medium rounded-full bg-primary text-primary-foreground px-3 py-1">
                            已服用
                          </span>
                          <span className="text-[12px] font-medium rounded-full border border-border px-3 py-1 text-muted-foreground">
                            稍后
                          </span>
                        </div>
                      </div>
                      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
                        <p className="text-[12px] text-muted-foreground">血压打卡</p>
                        <p className="text-[14px] font-black mt-1 sig-num">138/86 mmHg</p>
                      </div>
                      <div className="rounded-2xl p-3.5 bg-triage-amber-bg text-triage-amber">
                        <p className="text-[12px] font-medium">10月21日 · 门诊拆线复查</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 中：家属端 */}
            <div className="border-t md:border-t-0 md:border-x border-border bg-primary/5 p-7 md:p-10 flex flex-col animate-fade-rise">
              <p className="sig-eyebrow">家属端 · 照护协同</p>
              <h2 className="mt-4 font-black text-[clamp(1.6rem,2.8vw,2.2rem)] leading-[1.3]">
                帮得上忙的
                <br />
                家属协助
              </h2>
              <p className="mt-4 text-[15px] leading-[1.85] text-foreground/70">
                绑定患者后随时查看看护对象今日状态；漏服 30 分钟自动收到协助任务。
              </p>
              <p className="mt-3 text-[13px] leading-[1.7] text-muted-foreground">
                不在身边也能照护：代打卡、联系患者、需要时一键转医护。
              </p>
              <div className="mt-auto pt-6 flex justify-center">
                <div className="sig-phone">
                  <div className="sig-screen">
                    <div className="bg-triage-amber/90 px-4 py-2.5 flex items-center justify-between">
                      <p className="text-[13px] font-medium text-white">家属协助 · 陈明</p>
                      <p className="text-[12px] sig-num text-white/80">待处理 1</p>
                    </div>
                    <div className="p-4 space-y-3">
                      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
                        <p className="text-[12px] font-medium text-triage-amber">【待家属协助】睡前 21:00</p>
                        <p className="text-[14px] font-black mt-1">阿托伐他汀 20mg</p>
                        <p className="text-[12px] text-muted-foreground mt-1">超过 30 分钟未确认，请协助</p>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <span className="rounded-xl bg-primary text-primary-foreground text-[11px] font-medium px-2 py-2 text-center">已服药</span>
                        <span className="rounded-xl border border-border text-[11px] font-medium px-2 py-2 text-center">已联系</span>
                        <span className="rounded-xl border border-border text-[11px] font-medium px-2 py-2 text-center">转医护</span>
                      </div>
                      <div className="rounded-2xl bg-white p-3.5 shadow-sm">
                        <p className="text-[12px] text-muted-foreground">今日照护 · 陈桂芳</p>
                        <p className="text-[14px] font-black mt-1 sig-num">已服 3/4 次</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 右：医护端 */}
            <div className="sig-deep-bg p-7 md:p-10 flex flex-col animate-curtain-right">
              <p className="sig-eyebrow sig-deep-muted">医护端 · Web 工作台</p>
              <h2 className="mt-4 font-black text-[clamp(1.7rem,3vw,2.4rem)] leading-[1.3]">
                看得见的
                <br />
                风险信号
              </h2>
              <p className="sig-deep-muted mt-4 text-[15px] leading-[1.85]">
                红黄旗预警集中待办，患者 360 视图一屏尽览，随访报告一键归档。
              </p>
              <div className="mt-auto pt-8 space-y-3 max-w-md w-full md:ml-auto">
                <div className="rounded-2xl p-4 bg-sig-deep-card border border-sig-deep-border">
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] font-medium tracking-widest rounded-full px-3 py-1 bg-triage-red-bg text-triage-red">
                      RED
                    </span>
                    <p className="font-black text-foreground text-[15px]">陈桂芳 · 术后第 9 天 · 今晨自查</p>
                  </div>
                  <p className="sig-deep-muted mt-2 text-[13px] leading-[1.7]">
                    晨起胸闷、活动后气短，近 3 日收缩压 136-142mmHg，红旗规则直判，建议立即就医
                  </p>
                </div>
                <div className="rounded-2xl p-4 bg-sig-deep-card border border-sig-deep-border">
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] font-medium tracking-widest rounded-full px-3 py-1 bg-triage-amber-bg text-triage-amber">
                      YELLOW
                    </span>
                    <p className="font-black text-foreground text-[15px]">周建国 · 59 岁 · 高血压 3 级</p>
                  </div>
                  <p className="sig-deep-muted mt-2 text-[13px] leading-[1.7]">
                    近 3 日收缩压 152-163mmHg，血压控制不稳，建议加密随访
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 中央胶囊 */}
          <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 z-20 text-center hidden md:block">
            <p className="rounded-full bg-background/90 backdrop-blur border border-border px-5 py-2 text-sm font-medium shadow-sm">
              三方协同，一条闭环
            </p>
          </div>
        </section>

        {/* Section 2: Loop */}
        <section id="loop" className="py-14 md:py-20">
          <div className="container">
            <div className="max-w-2xl">
              <p className="sig-eyebrow">核心闭环</p>
              <h2 className="mt-4 font-black text-[clamp(1.6rem,3.2vw,2.4rem)] leading-[1.28]">
                一份出院小结，<span className="text-primary">跑完八步闭环</span>
              </h2>
            </div>
            <div className="mt-10">
              {/* 高密度三方协同矩阵：非卡片式，细分隔线 + 紧凑文字，角色 × 阶段一屏尽览 */}
              <div className="w-full max-w-full overflow-x-auto">
                <div className="min-w-[54rem]">
                  {/* 表头：四个阶段 */}
                  <div className="grid grid-cols-[4.5rem_repeat(4,1fr)] items-end border-b-2 border-foreground/25 pb-2.5">
                    <span className="text-xs font-medium text-muted-foreground">角色 / 阶段</span>
                    {['计划生成', '日常履约', '漏服升级', '风险闭环'].map((s, i) => (
                      <span key={s} className="px-3 text-[13px] font-black tracking-wide">
                        <span className="sig-num text-primary mr-1.5">0{i + 1}</span>
                        {s}
                      </span>
                    ))}
                  </div>
                  {/* 三条角色泳道 */}
                  {[
                    {
                      role: '患者',
                      sub: '手机端',
                      cells: [
                        ['拍照上传出院小结', 'AI 解析出计划草稿'],
                        ['到点提醒 · 一键打卡', '体征记录 · 助手随问随答'],
                        ['漏服后每 10 分钟提醒本人', '打卡即终止整条链路'],
                        ['症状自查红黄绿分级', '随访报告随时查看'],
                      ],
                    },
                    {
                      role: '家属',
                      sub: '手机端',
                      cells: [
                        ['授权绑定照护对象'],
                        ['查看今日服药进度', '代打卡（标注家属来源）'],
                        ['30 分钟无响应收到协助任务', '可代打卡 / 联系患者 / 转医护'],
                        ['红色事件同步通知家属'],
                      ],
                    },
                    {
                      role: '医护',
                      sub: '电脑网页版',
                      cells: [
                        ['人工校对，计划生效', '维护患者档案'],
                        ['360 视图监控依从率', '预警中心集中待办'],
                        ['1 小时无响应生成预警', '电话随访并录入处置'],
                        ['黄色 24h 随访 · 红色即时', '处置完成闭环解除'],
                      ],
                    },
                  ].map((r) => (
                    <div
                      key={r.role}
                      className="grid grid-cols-[4.5rem_repeat(4,1fr)] border-b border-border/70 py-3.5"
                    >
                      <div>
                        <p className="text-sm font-black leading-tight">{r.role}</p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">{r.sub}</p>
                      </div>
                      {r.cells.map((c, ci) => (
                        <div key={ci} className="space-y-1 border-l border-border/50 pl-3 pr-3">
                          {c.map((line) => (
                            <p key={line} className="text-[12.5px] leading-[1.55] text-foreground/75">
                              {line}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                从出院小结到随访报告，八步环环相扣；任意环节完成打卡，升级链路即时终止，不打扰任何人。
              </p>
            </div>
          </div>
        </section>

        {/* Section 2.5: 产品实景展示（愈见 CareLoop 自研界面高保真实景，严格居中自适应） */}
        <section id="showcase" className="py-12 md:py-20 bg-card/60 border-y border-border w-full max-w-full overflow-hidden">
          <div className="container max-w-6xl mx-auto px-4 sm:px-6">
            <div className="max-w-2xl mx-auto text-center">
              <p className="sig-eyebrow">产品实景 · 三端协同</p>
              <h2 className="mt-4 font-black text-[clamp(1.6rem,3.2vw,2.4rem)] leading-[1.28]">
                两部手机，<span className="text-primary">一台电脑</span>
              </h2>
              <p className="mt-4 text-muted-foreground text-[15px] leading-[1.85]">
                患者与家属用手机照护日常，医护在电脑工作台上掌控全局——三端数据实时同步。
              </p>
            </div>

            <div className="mt-10 grid md:grid-cols-3 gap-8 md:gap-6 items-center justify-items-center">
              {/* 患者端实景手机模型（尺寸收小，自研界面，严格居中） */}
              <div className="flex flex-col items-center w-full md:max-w-[17rem]">
                <div className="w-[15.5rem] rounded-[2.5rem] p-2.5 bg-neutral-900 shadow-2xl border-2 border-neutral-700/60 select-none">
                  {/* 灵动岛与听筒 */}
                  <div className="w-20 h-4 bg-black rounded-full mx-auto mb-2 flex items-center justify-end px-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-neutral-700" />
                  </div>

                  {/* 手机屏幕内部：愈见患者端真实高保真界面 */}
                  <div className="rounded-[1.9rem] bg-background border border-border/50 overflow-hidden text-left p-3 flex flex-col text-[11px] space-y-2.5">
                    {/* 手机顶部状态 */}
                    <div className="flex items-center justify-between text-muted-foreground px-1 text-[10px]">
                      <span className="font-semibold text-foreground">09:41</span>
                      <span className="flex items-center gap-1 font-mono">5G 100%</span>
                    </div>

                    {/* App 顶栏 */}
                    <div className="flex items-center justify-between bg-primary/10 rounded-xl px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground font-black text-[10px] grid place-items-center">
                          愈
                        </span>
                        <span className="font-bold text-foreground text-[12px]">愈见 CareLoop</span>
                      </div>
                      <span className="text-[10px] font-medium text-primary bg-primary/15 px-2 py-0.5 rounded-full">
                        患者端
                      </span>
                    </div>

                    {/* 患者状态概览卡 */}
                    <div className="rounded-xl bg-card border border-border p-2.5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-foreground text-[12px]">陈桂芳 · 68 岁</span>
                        <span className="text-[10px] text-muted-foreground">术后第 9 天</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">冠状动脉旁路移植术后（CABG）</p>
                      <div className="mt-2 flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">今日服药</span>
                        <span className="font-bold text-primary">3/4 · 还差睡前一次</span>
                      </div>
                    </div>

                    {/* 今日用药提醒列表 */}
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-bold text-muted-foreground px-1">今日用药清单</p>
                      <div className="rounded-xl border border-border bg-card p-2 flex items-center justify-between">
                        <div>
                          <p className="font-bold text-foreground text-[11px]">美托洛尔 47.5mg</p>
                          <p className="text-[10px] text-muted-foreground">早 08:00 · 餐后服用</p>
                        </div>
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md">
                          <Check className="w-3 h-3" /> 已服
                        </span>
                      </div>
                      <div className="rounded-xl border border-border bg-card p-2 flex items-center justify-between">
                        <div>
                          <p className="font-bold text-foreground text-[11px]">氯吡格雷 75mg</p>
                          <p className="text-[10px] text-muted-foreground">早 08:00 · 餐前服用</p>
                        </div>
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md">
                          <Check className="w-3 h-3" /> 已服
                        </span>
                      </div>
                      <div className="rounded-xl border border-primary/40 bg-primary/5 p-2 flex items-center justify-between">
                        <div>
                          <p className="font-bold text-primary text-[11px]">阿托伐他汀 20mg</p>
                          <p className="text-[10px] text-muted-foreground">睡前 21:00 · 待打卡</p>
                        </div>
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary bg-primary/20 px-2 py-0.5 rounded-md">
                          <Clock className="w-3 h-3" /> 待服
                        </span>
                      </div>
                    </div>

                    {/* 随访日程提示 */}
                    <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        <div>
                          <p className="font-bold text-foreground text-[10px]">10月21日 · 门诊拆线复查</p>
                          <p className="text-[9px] text-muted-foreground">心外科随访门诊 3诊室</p>
                        </div>
                      </div>
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    </div>

                    {/* 手机底部 5 Tab 导航 */}
                    <div className="grid grid-cols-5 pt-1.5 border-t border-border text-[9px] text-center text-muted-foreground">
                      <span className="text-primary font-bold">今日</span>
                      <span>用药</span>
                      <span>随访</span>
                      <span>助手</span>
                      <span>消息</span>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-sm font-bold text-foreground">患者端 · 移动界面实景</p>
                <p className="text-xs text-muted-foreground mt-0.5">清晰计划 · 到点打卡 · 智能自查</p>
              </div>

              {/* 家属端实景手机模型（待我处理 + 三动作） */}
              <div className="flex flex-col items-center w-full md:max-w-[17rem]">
                <div className="w-[15.5rem] rounded-[2.5rem] p-2.5 bg-neutral-900 shadow-2xl border-2 border-neutral-700/60 select-none">
                  <div className="w-20 h-4 bg-black rounded-full mx-auto mb-2 flex items-center justify-end px-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-neutral-700" />
                  </div>
                  <div className="rounded-[1.9rem] bg-background border border-border/50 overflow-hidden text-left p-3 flex flex-col text-[11px] space-y-2.5">
                    <div className="flex items-center justify-between text-muted-foreground px-1 text-[10px]">
                      <span className="font-semibold text-foreground">09:41</span>
                      <span className="flex items-center gap-1 font-mono">5G 100%</span>
                    </div>
                    {/* 家属端头部横幅 */}
                    <div className="rounded-xl bg-triage-amber/90 px-2.5 py-1.5">
                      <p className="font-bold text-white text-[11px]">家属协助 · 陈明正在照护</p>
                      <p className="text-[9px] text-white/80 mt-0.5">仅可代打卡与响应，不改医嘱</p>
                    </div>
                    {/* 照护对象状态卡 */}
                    <div className="rounded-xl bg-card border border-border p-2.5 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-foreground text-[12px]">陈桂芳 · 68 岁</span>
                        <span className="text-[10px] text-muted-foreground">术后第 9 天</span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">今日服药</span>
                        <span className="font-bold text-primary">3/4 · 还差睡前一次</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">下次用药</span>
                        <span className="font-bold text-foreground">21:00 阿托伐他汀</span>
                      </div>
                    </div>
                    {/* 待我处理：L2 协助任务 */}
                    <div className="rounded-xl border border-triage-amber/40 bg-triage-amber-bg p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-triage-amber">待我处理 · 1 件</span>
                        <Clock className="w-3 h-3 text-triage-amber" />
                      </div>
                      <p className="text-[11px] font-bold text-foreground mt-1">睡前 21:00 阿托伐他汀 20mg</p>
                      <p className="text-[10px] text-muted-foreground">超过 30 分钟未确认，请协助督促</p>
                      <div className="mt-2 grid grid-cols-3 gap-1">
                        <span className="rounded-lg bg-primary text-primary-foreground text-[9px] font-medium py-1.5 text-center">已服药</span>
                        <span className="rounded-lg border border-border bg-card text-[9px] font-medium py-1.5 text-center text-foreground">已联系</span>
                        <span className="rounded-lg border border-border bg-card text-[9px] font-medium py-1.5 text-center text-foreground">转医护</span>
                      </div>
                    </div>
                    {/* 底部 4 Tab */}
                    <div className="grid grid-cols-4 pt-1.5 border-t border-border text-[9px] text-center text-muted-foreground">
                      <span className="text-primary font-bold">首页</span>
                      <span>代打卡</span>
                      <span>任务</span>
                      <span>消息</span>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-sm font-bold text-foreground">家属端 · 照护协同实景</p>
                <p className="text-xs text-muted-foreground mt-0.5">代打卡 · 响应任务 · 实时掌握进度</p>
              </div>

              {/* 医护端 Mac 电脑网页版模型（屏幕 + 支架底座，体现桌面使用形态） */}
              <div className="flex flex-col items-center w-full md:col-span-1">
                <div className="w-full max-w-[26rem] select-none">
                  {/* Mac 屏幕 */}
                  <div className="rounded-xl border-[6px] border-neutral-800 bg-neutral-800 shadow-2xl overflow-hidden">
                    <div className="rounded-t-[4px] overflow-hidden">
                      {/* 浏览器顶栏仿真 */}
                      <div className="px-3.5 py-2 bg-muted/80 border-b border-border flex items-center gap-2">
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                        </div>
                        <div className="flex-1 min-w-0 bg-background/80 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground font-mono truncate text-center">
                          app-ezvlp6ds1hqa.miaoda.online/clinician/patients
                        </div>
                      </div>

                      {/* 浏览器内部：医护工作台宽屏界面（左侧栏 + 右侧内容区） */}
                      <div className="flex bg-background text-[11px] text-left" style={{ height: '17.5rem' }}>
                        {/* 左侧导航栏 */}
                        <div className="w-[7.5rem] shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
                          <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-sidebar-border">
                            <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground font-black text-[10px] grid place-items-center shrink-0">
                              愈
                            </span>
                            <span className="font-bold text-foreground text-[11px] truncate">医护工作台</span>
                          </div>
                          <div className="flex-1 py-2 px-2 space-y-1">
                            {['工作台', '患者管理', '预警中心', '随访报告', '知识库'].map((m, i) => (
                              <div
                                key={m}
                                className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[10px] font-medium ${
                                  i === 1 ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                                }`}
                              >
                                <span>{m}</span>
                                {i === 2 ? (
                                  <span className="rounded-full bg-destructive text-white text-[8px] font-bold px-1.5 py-0.5 sig-num">
                                    5
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                          <div className="px-3 py-2 border-t border-sidebar-border">
                            <p className="text-[9px] text-muted-foreground truncate">心外科 · 王心怡</p>
                          </div>
                        </div>

                        {/* 右侧内容区：患者列表宽屏 */}
                        <div className="flex-1 min-w-0 p-3 space-y-2 overflow-hidden">
                          <div className="flex items-center justify-between">
                            <p className="font-bold text-foreground text-[12px]">患者管理</p>
                            <span className="text-[9px] text-muted-foreground">共 2 位在管</span>
                          </div>
                          {/* 指标行 */}
                          <div className="grid grid-cols-3 gap-1.5">
                            <div className="rounded-lg border border-border bg-card p-1.5">
                              <p className="text-[8px] text-muted-foreground">在管患者</p>
                              <p className="text-[12px] font-black text-foreground sig-num mt-0.5">2</p>
                            </div>
                            <div className="rounded-lg border border-triage-red/30 bg-triage-red-bg p-1.5">
                              <p className="text-[8px] font-medium text-triage-red">待处预警</p>
                              <p className="text-[12px] font-black text-triage-red sig-num mt-0.5">5 件</p>
                            </div>
                            <div className="rounded-lg border border-border bg-card p-1.5">
                              <p className="text-[8px] text-muted-foreground">今日依从</p>
                              <p className="text-[12px] font-black text-primary sig-num mt-0.5">75%</p>
                            </div>
                          </div>
                          {/* 患者行 */}
                          <div className="rounded-lg border border-triage-red/30 bg-triage-red-bg/60 p-2 flex items-center justify-between">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-foreground text-[11px]">陈桂芳 (68岁)</span>
                                <span className="text-[8px] bg-triage-red/15 text-triage-red px-1.5 py-0.5 rounded font-medium">
                                  红色预警
                                </span>
                              </div>
                              <p className="text-[9px] text-muted-foreground mt-0.5 truncate">
                                冠脉搭桥术后 · 家属已响应 · 今晨胸闷气短
                              </p>
                            </div>
                            <span className="text-[9px] font-medium text-white bg-triage-red px-2 py-1 rounded-md shrink-0 ml-1">
                              立即处理
                            </span>
                          </div>
                          <div className="rounded-lg border border-triage-amber/30 bg-triage-amber-bg/60 p-2 flex items-center justify-between">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-foreground text-[11px]">周建国 (59岁)</span>
                                <span className="text-[8px] bg-triage-amber/15 text-triage-amber px-1.5 py-0.5 rounded font-medium">
                                  黄色预警
                                </span>
                              </div>
                              <p className="text-[9px] text-muted-foreground mt-0.5 truncate">
                                高血压3级 · 近3日收缩压152-163 · 建议加密随访
                              </p>
                            </div>
                            <span className="text-[9px] font-medium text-foreground border border-border bg-card px-2 py-1 rounded-md shrink-0 ml-1">
                              电话随访
                            </span>
                          </div>
                          {/* 绑定家属提示行 */}
                          <div className="rounded-lg border border-border bg-card p-2 flex items-center gap-1.5">
                            <Users className="w-3 h-3 text-primary shrink-0" />
                            <p className="text-[9px] text-muted-foreground truncate">
                              陈桂芳已绑定家属陈明（儿子）· 漏服 30 分钟自动通知家属
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* 屏幕下边框的 chin */}
                    <div className="h-3 bg-neutral-800 border-t border-neutral-700/60 flex items-center justify-center">
                      <span className="h-0.5 w-16 rounded-full bg-neutral-700/70" />
                    </div>
                  </div>
                  {/* Mac 支架底座 */}
                  <div className="mx-auto h-4 w-24 bg-gradient-to-b from-neutral-300 to-neutral-500 rounded-b-lg rounded-t-sm shadow-md" />
                  <div className="mx-auto h-1.5 w-44 bg-gradient-to-b from-neutral-400 to-neutral-600 rounded-b-full shadow-sm" />
                </div>
                <p className="mt-3 text-sm font-bold text-foreground">医护端 · 电脑网页版实景</p>
                <p className="text-xs text-muted-foreground mt-0.5">宽屏工作台 · 预警中心 · 患者 360</p>
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: Escalation */}
        <section id="escalation" className="py-14 md:py-20 bg-secondary/50">
          <div className="container">
            <div className="max-w-2xl">
              <p className="sig-eyebrow">升级链路 · 三级响应</p>
              <h2 className="mt-4 font-black text-[clamp(1.6rem,3.2vw,2.4rem)] leading-[1.28]">
                一次漏服，<span className="text-primary">三方接力</span>
              </h2>
              <p className="mt-4 text-muted-foreground text-[15px] leading-[1.85]">
                漏服后每 10 分钟提醒本人打卡；30 分钟无响应请家属协助；1 小时无响应医护端开始处理。任意时刻打卡确认，整条链路立即终止。
              </p>
            </div>
            <div className="mt-10 grid md:grid-cols-[13rem_1fr] gap-8 md:gap-14">
              {/* 常驻入口：任意时刻可点击切换 */}
              <aside className="md:sticky md:top-28 self-start">
                <div className="flex flex-wrap gap-2 md:flex-col">
                  {ESC_STEPS.map((s, i) => (
                    <button
                      key={s.title}
                      type="button"
                      onClick={() => setEscStep(i)}
                      onMouseEnter={() => setEscStep(i)}
                      className={`rounded-full border px-4 py-2 text-sm font-medium transition-all ${
                        escStep === i
                          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                          : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground'
                      }`}
                    >
                      {s.title.split(' · ')[0]}
                    </button>
                  ))}
                </div>
                <p className="mt-4 hidden text-xs text-muted-foreground md:block">点击或悬停切换阶段</p>
              </aside>

              {/* 一次渲染一张：当前层级卡片 */}
              <div key={escStep} className="animate-fade-rise">
                {(() => {
                  const s = ESC_STEPS[escStep];
                  const isLast = escStep === ESC_STEPS.length - 1;
                  return (
                    <div
                      className={`min-h-[15rem] rounded-3xl border p-7 md:p-9 ${
                        isLast ? 'border-sig-deep-border bg-sig-deep-card' : 'border-border bg-card'
                      }`}
                    >
                      <p className={`text-xs font-medium tracking-[0.2em] ${isLast ? 'text-triage-red' : 'text-muted-foreground'} sig-num`}>
                        {s.time}
                      </p>
                      <h3 className={`mt-3 font-black text-2xl ${isLast ? 'text-triage-red' : ''}`}>{s.title}</h3>
                      <p className={`mt-3 text-[15px] leading-[1.85] ${isLast ? 'sig-deep-muted' : 'text-muted-foreground'}`}>
                        {s.body}
                      </p>
                      <div className="mt-6 flex items-center gap-2">
                        {ESC_STEPS.map((_, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setEscStep(i)}
                            aria-label={`切换到第 ${i + 1} 级`}
                            className={`h-1.5 rounded-full transition-all ${
                              escStep === i ? 'w-8 bg-primary' : 'w-4 bg-border hover:bg-primary/50'
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </section>

        {/* Section 4: Triage */}
        <section id="triage" className="py-14 md:py-20">
          <div className="container">
            <div className="max-w-2xl">
              <p className="sig-eyebrow">症状自查 · 三级分诊</p>
              <h2 className="mt-4 font-black text-[clamp(1.6rem,3.2vw,2.4rem)] leading-[1.28]">
                症状一勾，<span className="text-primary">风险自明</span>
              </h2>
            </div>
            <div className="mt-10 grid md:grid-cols-3 gap-4 md:gap-5">
              <div className="rounded-3xl p-7 bg-triage-green-bg border border-triage-green/20">
                <span className="w-10 h-10 rounded-full bg-white/80 grid place-items-center">
                  <CheckCircle2 className="h-5 w-5 text-triage-green" />
                </span>
                <h3 className="mt-4 font-black text-xl text-triage-green">绿色 · 居家观察</h3>
                <p className="mt-3 text-[15px] leading-[1.85] text-foreground/70">
                  症状轻、生命体征平稳。按计划继续打卡用药与体征记录，注意休息。
                </p>
                <p className="mt-5 text-[13px] font-medium rounded-full bg-white/70 px-4 py-2 w-fit text-triage-green">
                  不上报，继续观察
                </p>
              </div>
              <div className="rounded-3xl p-7 bg-triage-amber-bg border border-triage-amber/20">
                <span className="w-10 h-10 rounded-full bg-white/80 grid place-items-center">
                  <AlertTriangle className="h-5 w-5 text-triage-amber" />
                </span>
                <h3 className="mt-4 font-black text-xl text-triage-amber">黄色 · 联系随访</h3>
                <p className="mt-3 text-[15px] leading-[1.85] text-foreground/70">
                  中度风险或指标波动。生成黄色风险预警单（区别于漏服产生的依从性预警），护士 24 小时内电话随访评估。
                </p>
                <p className="mt-5 text-[13px] font-medium rounded-full bg-white/70 px-4 py-2 w-fit text-triage-amber">
                  自动上报医护端
                </p>
              </div>
              <div className="rounded-3xl p-7 bg-triage-red-bg border border-triage-red/20">
                <span className="w-10 h-10 rounded-full bg-white/80 grid place-items-center">
                  <ShieldAlert className="h-5 w-5 text-triage-red" />
                </span>
                <h3 className="mt-4 font-black text-xl text-triage-red">红色 · 立即就医</h3>
                <p className="mt-3 text-[15px] leading-[1.85] text-foreground/70">
                  命中红旗关键词或体征超红线。实时推送医护站并同步紧急联系人。
                </p>
                <p className="mt-5 text-[13px] font-medium rounded-full bg-white/70 px-4 py-2 w-fit text-triage-red">
                  高优先级红旗事件
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Section 5: CTA */}
        <section id="cta" className="py-14 md:py-20">
          <div className="container">
            <div className="rounded-[2rem] bg-card border border-border p-10 md:p-14 text-center">
              <p className="sig-eyebrow justify-center">愈见 · CareLoop</p>
              <h2 className="mt-4 font-black text-[clamp(1.7rem,3.4vw,2.6rem)] leading-[1.28]">三方协同，闭环合一</h2>
              <p className="mt-4 text-muted-foreground text-[15px] leading-[1.85] max-w-xl mx-auto">
                出院后那几周，患者不再单打独斗，家属不再干着急，医护不再凭电话追踪。上传出院小结，剩下的交给愈见。
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                <Link
                  to="/login?role=patient"
                  className="rounded-full bg-primary text-primary-foreground font-medium px-7 py-3 text-[15px] hover:brightness-95 transition-all shadow-sm"
                >
                  患者端 · 开始使用
                </Link>
                <Link
                  to="/login?role=family"
                  className="rounded-full border border-border font-medium px-7 py-3 text-[15px] hover:border-primary/50 transition-colors"
                >
                  家属端 · 照护协同
                </Link>
                <Link
                  to="/login?role=clinician"
                  className="rounded-full border border-border font-medium px-7 py-3 text-[15px] hover:border-primary/50 transition-colors"
                >
                  医护端 · 登录工作台
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="py-8 border-t border-border">
        <div className="container flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            © 2026 愈见 CareLoop · iCAN AI 无代码智能体挑战赛 · 演示数据均为虚构脱敏
          </p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
