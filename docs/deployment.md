# 部署说明

首版推荐一台机器、一个服务进程、一个 SQLite 数据目录。先用演示环境走完整个流程，再在自己的 HTTPS 地址上使用正式名单。

## 本机运行

安装 Node.js 22.13 或更新版本，推荐 Node.js 24，在项目目录执行：

```sh
npm start
```

首次启动创建 `data/` 和其中的私密管理员入口 `admin-entry.html`。保持终端运行，使用浏览器打开这个文件进入后台。也可在主页或活动指引点击“组织者后台”，输入自己 `data/admin.key` 文件中的完整管理密钥。停止服务后暂停访问，重启同一数据目录会保留活动数据。

自定义环境变量时，可复制示例配置：

```sh
cp .env.example .env
npm start
```

`.env` 是本地私密文件，已被 Git 忽略。`npm start` 会在文件存在时读取它；也可以由服务管理器设置环境变量。已有系统环境变量优先，部署时保持二者一致。

| 配置 | 本文示例 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；本机运行时只允许本机访问 |
| `PORT` | `3000` | 服务端口 |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:3000` | 浏览器实际使用的来源地址，不含路径 |
| `BASE_PATH` | `/event` | 网站所在路径 |
| `DATA_DIR` | `./data` | SQLite 与私密管理员资料目录 |

本说明的命令都在项目根目录运行，`DATA_DIR` 的相对路径因此指向该目录下的位置；由服务管理器启动时建议填写绝对路径。首次运行会创建 `event.sqlite3`、`admin.key` 和 `admin-entry.html`；这些文件都应留在私密数据目录。

上述配置对应公共地址 `http://127.0.0.1:3000/event/`。管理员入口包含凭据，不能与公共地址混用。

## Docker 本机试运行

以下命令从项目目录执行。镜像基于 Node.js 24，使用普通 `node` 用户运行；运行时数据放到单独的数据卷。

```sh
docker build -t city-event-kit .
docker volume create city-event-kit-data
docker run -d \
  --name city-event-kit \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v city-event-kit-data:/app/data \
  city-event-kit
```

取得私密管理员入口：

```sh
docker cp city-event-kit:/app/data/admin-entry.html ./admin-entry.html
```

用本机浏览器打开复制出来的文件。请勿把它提交到仓库、放进网站静态目录或发到公共群。公共页面是 `http://127.0.0.1:3000/event/`。

如果要使用主页上的“组织者后台”登录框，可另外把自己的管理密钥文件复制到本机，再用文本编辑器读取。该文件同样不能公开或群发：

```sh
docker cp city-event-kit:/app/data/admin.key ./admin.key
```

查看运行状态与停止服务：

```sh
docker ps --filter name=city-event-kit
docker logs --tail 30 city-event-kit
docker stop city-event-kit
```

数据卷需要持续保留。重建容器时继续挂载同一个卷；删除容器不等于删除卷，但删除卷会删除其中数据。不要让两个实例同时使用同一份 SQLite 文件。

使用宿主机目录替代命名卷时，先确认目录只对必要人员开放，且容器中的 `node` 用户可以写入。不要把数据目录映射到可公开下载的 Web 路径。

## 自己的 HTTPS 服务器

Docker 本身不提供 HTTPS。对外使用前，由部署者准备域名、有效证书和反向代理。下面以保留域名 `event.example.org` 为填写示例，应替换为自己管理的域名。

启动正式容器时显式指定外部来源地址：

```sh
docker run -d \
  --name city-event-kit \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e PUBLIC_ORIGIN=https://event.example.org \
  -e BASE_PATH=/event \
  -v city-event-kit-data:/app/data \
  city-event-kit
```

这条命令用于新建容器；如果同名容器已存在，先保存备份并停止旧容器，再按自己的部署流程替换，不要删除数据卷。修改公开地址后重新取得管理员入口并生成本场二维码。

反向代理把 `https://event.example.org/event/` 的请求转发至 `http://127.0.0.1:3000/event/`，保留完整路径。`PUBLIC_ORIGIN` 必须和浏览器地址栏使用的协议、域名与端口一致。不要向公网直接开放示例中的无加密端口，也不要把服务器上的 `data/` 作为静态目录发布。

正式开放前，用参加者的手机完成以下检查：

1. 公共页面、评委入口和二维码都指向正式 HTTPS 地址。
2. 输入虚构测试身份后可以保存并读回评分与投票回执。
3. 截止后不能继续提交，公布结果与导出一致。
4. 已保存并验证一次独立备份；正式库中没有演示记录。
5. 服务由可靠的进程或容器管理方式保持运行，主机不会在活动中休眠。

如果在正式库中做了测试，不要直接把测试票当正式票。使用独立演示库演练，再启动清洁的正式数据目录。

## 可选 CloudBase 适配

`cloud/index.mjs` 与 `cloud/store.mjs` 保留 CloudBase 数据库存储适配。默认 `npm start` 不使用它，也不会创建云环境、付费资源或上传数据。

自行选择这条路线时，需要在单独部署目录安装 `@cloudbase/js-sdk`，建立独立环境和对应数据表，配置 `CLOUDBASE_ENV_ID`、`CLOUDBASE_API_KEY`、`AWARDS_ADMIN_TOKEN`、`PUBLIC_ORIGIN` 与 `BASE_PATH`，并实际验证静态文件路径、数据库权限、持久化与备份。SDK 不包含在默认无依赖启动包中。

这份文档没有提供一键云部署承诺。首次使用优先完成本地或 Docker 路线；不要把活动模板连接到其他项目正在使用的数据库。
