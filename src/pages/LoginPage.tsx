import React, { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { HeartPulse, Monitor, ShieldAlert, Smartphone, User } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { BrandMark } from '@/components/common/BrandMark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { signInWithUsername, registerWithRole } = useAuth();
  // 三端分流：落地页 CTA 携带 ?role= 参数，登录页据此显示对应角色入口提示
  const [searchParams] = useSearchParams();
  const roleParam = searchParams.get('role');
  const entryRole: 'patient' | 'clinician' | 'family' | null =
    roleParam === 'patient' || roleParam === 'clinician' || roleParam === 'family' ? roleParam : null;

  // 登录表单
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // 快捷体验：两步选择（身份 → 演示账号）
  const [demoRole, setDemoRole] = useState<'patient' | 'family' | 'clinician'>(
    entryRole ?? 'patient',
  );
  const [demoAccount, setDemoAccount] = useState<string | null>(null);
  // 三身份演示账号清单（只展示当前所选身份的账号）
  const DEMO_ACCOUNTS: Record<'patient' | 'family' | 'clinician', Array<{ username: string; password: string; name: string; desc: string }>> = {
    patient: [
      { username: 'guifang', password: 'GuiFang@CareLoop2026', name: '陈桂芳', desc: '68 岁，冠脉搭桥术后第 9 天' },
      { username: 'jianguo', password: 'JianGuo@CareLoop2026', name: '周建国', desc: '59 岁，高血压 3 级' },
    ],
    family: [
      { username: 'chenming', password: 'ChenMing@CareLoop2026', name: '陈明', desc: '陈桂芳之子，照护协同' },
    ],
    clinician: [
      { username: 'doctor_wang', password: 'DrWang@CareLoop2026', name: '王心怡', desc: '心外科，医护工作台' },
    ],
  };

  // 注册表单
  const [regUsername, setRegUsername] = useState('');
  const [regFullName, setRegFullName] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regRole, setRegRole] = useState<'patient' | 'clinician'>('patient');
  const [regPhone, setRegPhone] = useState('');
  const [regLoading, setRegLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginUsername.trim() || !loginPassword) {
      toast.error('请输入用户名和密码');
      return;
    }
    setLoginLoading(true);
    const { error } = await signInWithUsername(loginUsername.trim(), loginPassword);
    setLoginLoading(false);
    if (error) {
      toast.error(`登录失败: ${error.message || '用户名或密码错误'}`);
    } else {
      toast.success('登录成功');
      // 按用户名预判三端分流（RouteGuard 兜底校验角色）
      const uname = loginUsername.trim().toLowerCase();
      if (uname.includes('doc') || uname === 'doctor_wang') {
        navigate('/clinician/dashboard');
      } else if (uname.includes('chenming') || uname.includes('family')) {
        navigate('/family/dashboard');
      } else {
        navigate('/patient/dashboard');
      }
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regUsername.trim() || !regPassword || !regFullName.trim()) {
      toast.error('请填写完整注册信息');
      return;
    }
    if (regPassword.length < 6) {
      toast.error('密码长度至少6位');
      return;
    }

    setRegLoading(true);
    const { error } = await registerWithRole({
      username: regUsername.trim(),
      password: regPassword,
      full_name: regFullName.trim(),
      role: regRole,
      phone: regPhone.trim() || undefined,
    });
    setRegLoading(false);

    if (error) {
      toast.error(`注册失败: ${error.message}`);
    } else {
      toast.success('注册并登录成功！');
      if (regRole === 'clinician') {
        navigate('/clinician/patients');
      } else {
        navigate('/patient/dashboard');
      }
    }
  };

  const fillDemoAccount = (username: string, pass: string) => {
    setLoginUsername(username);
    setLoginPassword(pass);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <Link to="/" className="inline-flex items-center gap-2 mb-4">
          <BrandMark className="w-10 h-10 text-primary" title="" />
          <span className="font-black text-2xl tracking-wide text-foreground">愈见 CareLoop</span>
        </Link>
        <p className="text-sm text-muted-foreground">出院患者全周期照护助手</p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold">欢迎进入</CardTitle>
            <CardDescription>患者、家属与医护人员登录入口</CardDescription>
          </CardHeader>
          <CardContent>
            {/* 医疗合规提示 */}
            <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-triage-amber/40 bg-triage-amber-bg px-3.5 py-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-triage-amber" />
              <p className="text-xs leading-relaxed text-triage-amber">
                本工具仅作健康管理辅助，不构成医疗诊断，请遵医嘱。出现紧急症状请立即就医或拨打 120。
              </p>
            </div>
            <Tabs defaultValue="login" className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="login">账号登录</TabsTrigger>
                <TabsTrigger value="register">快速注册</TabsTrigger>
              </TabsList>

              {/* 登录选项卡 */}
              <TabsContent value="login">
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-user">用户名</Label>
                    <Input
                      id="login-user"
                      type="text"
                      placeholder="例如: guifang 或 doctor_wang"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      required
                      autoComplete="username"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="login-pass">密码</Label>
                    </div>
                    <Input
                      id="login-pass"
                      type="password"
                      placeholder="请输入密码"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                    />
                  </div>
                  <Button type="submit" className="w-full font-medium" disabled={loginLoading}>
                    {loginLoading ? '登录中...' : '立即登录'}
                  </Button>
                </form>

                {/* 快捷体验：第一步选身份，第二步选该身份演示账号 */}
                <div className="mt-6 pt-5 border-t border-border">
                  <p className="text-xs font-medium text-muted-foreground mb-2.5">快捷体验（先选身份）：</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        { key: 'patient', label: '患者', icon: Smartphone },
                        { key: 'family', label: '家属', icon: HeartPulse },
                        { key: 'clinician', label: '医护', icon: Monitor },
                      ] as const
                    ).map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => {
                          setDemoRole(r.key);
                          setDemoAccount(null);
                        }}
                        className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-sm font-medium transition-all ${
                          demoRole === r.key
                            ? 'border-primary bg-primary/10 text-primary font-bold'
                            : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        <r.icon className="h-5 w-5" />
                        {r.label}
                      </button>
                    ))}
                  </div>
                  {demoRole && (
                    <div className="mt-2.5 space-y-2">
                      {DEMO_ACCOUNTS[demoRole].map((acc) => (
                        <button
                          key={acc.username}
                          type="button"
                          onClick={() => {
                            setDemoAccount(acc.username);
                            fillDemoAccount(acc.username, acc.password);
                          }}
                          className={`w-full flex items-center justify-between rounded-xl border p-2.5 text-left text-xs transition-colors ${
                            demoAccount === acc.username
                              ? 'border-primary bg-primary/10'
                              : 'border-border bg-muted/40 hover:bg-muted'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <User className="h-3.5 w-3.5 shrink-0 text-primary" />
                            <span>
                              <span className="block font-bold text-foreground">
                                {acc.name}（{acc.username}）
                              </span>
                              <span className="block text-[11px] text-muted-foreground mt-0.5">{acc.desc}</span>
                            </span>
                          </span>
                          <span className="shrink-0 text-[11px] font-medium text-primary">填入</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* 注册选项卡 */}
              <TabsContent value="register">
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>我是</Label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setRegRole('patient')}
                        className={`p-3 rounded-xl border text-sm font-medium transition-all ${
                          regRole === 'patient'
                            ? 'border-primary bg-primary/10 text-primary font-bold'
                            : 'border-border bg-card text-muted-foreground'
                        }`}
                      >
                        出院患者 / 家属
                      </button>
                      <button
                        type="button"
                        onClick={() => setRegRole('clinician')}
                        className={`p-3 rounded-xl border text-sm font-medium transition-all ${
                          regRole === 'clinician'
                            ? 'border-primary bg-primary/10 text-primary font-bold'
                            : 'border-border bg-card text-muted-foreground'
                        }`}
                      >
                        医护 / 随访专员
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-name">真实姓名</Label>
                    <Input
                      id="reg-name"
                      type="text"
                      placeholder="例如: 李阿姨 / 张护士"
                      value={regFullName}
                      onChange={(e) => setRegFullName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-user">用户名（字母数字）</Label>
                    <Input
                      id="reg-user"
                      type="text"
                      placeholder="登录用户名，如: lisi_2026"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-pass">登录密码</Label>
                    <Input
                      id="reg-pass"
                      type="password"
                      placeholder="至少 6 位字符"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-phone">联系电话（选填）</Label>
                    <Input
                      id="reg-phone"
                      type="tel"
                      placeholder="用于接收随访短信提醒"
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value)}
                    />
                  </div>

                  <Button type="submit" className="w-full font-medium" disabled={regLoading}>
                    {regLoading ? '正在创建...' : '立即注册并登录'}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          登录即代表同意平台使用协议与隐私政策；演示系统数据已脱敏
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
