# 服务器部署

运行需要 Node.js 24 或更新版本。项目没有 npm 运行时依赖；仓库里的 `engine/` 已包含运行所需的 AI 引擎文件。

## 1. 获取代码

```sh
git clone --recurse-submodules git@github.com:GreyIcesea/2048-AI.git
cd 2048-AI
```

仓库为私有时，服务器需要配置对这个仓库的 GitHub 读取权限。只运行网站时可以不拉取 `upstream/` 子模块；运行 `npm run build` 时必须拉取它。

## 2. 设置管理员密码并启动

首次启动必须设置 `ADMIN_PASSWORD`。它用于创建用户名为 `admin` 的超级管理员，并以随机盐和 scrypt 哈希写入 `data/2048.sqlite`。不要把真实密码写进仓库。以后启动若继续提供这个变量，会将管理员密码同步为变量中的值。

```sh
export ADMIN_PASSWORD='请换成你的管理员密码'
export PUBLIC_ORIGIN='https://2048.example.com'
npm start
```

`PUBLIC_ORIGIN` 填写访问网站的完整根地址。只在服务器本机浏览 `http://127.0.0.1:2048` 时可以省略。服务只监听 `127.0.0.1:2048`，因此对外访问需要同机的反向代理。外部使用 HTTPS 时，Cookie 会带 `Secure` 标记。

## 3. 反向代理示例

以下是 Nginx 站点配置的核心部分。将域名替换成自己的，并在代理层配置 HTTPS 证书。

```nginx
server {
    listen 443 ssl;
    server_name 2048.example.com;
    # 在这里配置 ssl_certificate 和 ssl_certificate_key

    location / {
        proxy_pass http://127.0.0.1:2048;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

确保 `PUBLIC_ORIGIN` 与浏览器实际访问的地址一致。数据库保存在 `data/`，更新代码前先备份该目录；不要把它加入 Git。平台 AI 测试在服务重启后会以暂停状态恢复，可由管理员继续。
