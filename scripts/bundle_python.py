#!/usr/bin/env python3
"""打包阶段：固化随包分发的 Python 运行时。

历史背景
--------
本脚本早期用于把桌面 Python 后端（``apps/desktop-py``）连同其虚拟环境一起
拷进 Electron 的 ``extraResources``（``resources/python``），让包内主进程能
直接 spawn 一个**自带、可复现**的 Python 解释器，而不是依赖用户机器上碰巧
装了什么版本。

现状（2026-10）
--------------
``apps/desktop-py`` 已被删除，桌面智能体收敛为**唯一内核**：``apps/agent-ts``——
一个零依赖的 Node/TypeScript 运行时（TypeScript 原生剥离类型，Node 22.18+ 直接跑
``.ts``，连 ``tsx`` 都不装）。主进程 ``src/main.js`` 不再 spawn 任何 Python 进程，
``apps/desktop-node/package.json`` 的 ``build.extraResources`` 也已去掉 Python 相关条目。

因此本脚本现在**无事可做**：没有 Python 后端可打，也不应再往包里塞一个无用的
解释器（白占体积、还可能和用户机器上的 Python 混淆）。保留它只是为了让
``pack`` / ``dist`` 的调用链 ``python ../../scripts/bundle_python.py && electron-builder ...``
不中断——它已退化为一个安全、幂等、退出码 0 的空操作。

未来若重新引入需要随包分发的 Python 运行时，在这里实现固化逻辑：
  1. 定位源 venv / 嵌入式 Python（env ``EVAWORK_PYTHON_SRC``，默认 ``apps/desktop-py/.venv``）；
  2. 按需裁剪（去掉 ``__pycache__`` / ``*.pyc`` / 测试依赖）；
  3. 拷到 ``apps/desktop-node/resources/python``，并在 ``package.json`` 的
     ``extraResources`` 里补一条 ``from: resources/python``。

本脚本从 ``apps/desktop-node`` 目录被调用（``npm --prefix apps/desktop-node run dist``），
故相对路径以该目录为基准；这里统一解析到工程根，方便以后扩展。
"""

import os
import sys


def project_root() -> str:
    """调用方在 apps/desktop-node，向上两级即工程根。"""
    here = os.path.dirname(os.path.abspath(__file__))
    # scripts/bundle_python.py -> 工程根
    return os.path.dirname(here)


def main() -> int:
    root = project_root()
    desktop_node = os.path.join(root, "apps", "desktop-node")

    # 旧 Python 后端目录：已删除即为预期状态。
    py_backend = os.path.join(root, "apps", "desktop-py")
    if os.path.isdir(py_backend):
        # 防御性：若哪天又加回来了，明确报错提醒维护者来真正实现打包，
        # 而不是静默打成空包。
        sys.stderr.write(
            "[bundle_python] 检测到 apps/desktop-py 已存在，但本脚本尚未实现其打包逻辑；"
            "请在 scripts/bundle_python.py 中补充固化步骤后再发布。\n"
        )
        return 1

    print(
        "[bundle_python] Python 后端已废弃（apps/desktop-py 删除），智能体仅剩零依赖 "
        "Node 运行时 agent-ts；无可打包的 Python 运行时，跳过。cwd=%s"
        % desktop_node
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
