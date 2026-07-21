/*
 * OpenDesk CI Pipeline（脚本式）
 *
 * 触发方式：GitCode PR Webhook → Generic Webhook Trigger Plugin
 * 流程：拉取 main → merge PR 分支 → build → test → 回报结果（含日志）到 GitCode PR
 */

// ── 配置区（按实际修改） ──
def GITCODE_API_BASE = 'https://api.gitcode.com/api/v5'
def NODEJS_HOME      = '/root/.nvm/versions/node/v25.9.0/'

node {
    def ciLogDir = "${env.WORKSPACE}/ci-logs"
    def buildResult = 'success'

    // 从 Webhook 注入的 PR_REPO_URL 自动解析 owner/repo
    // PR_REPO_URL 格式：https://gitcode.com/owner/repo.git
    // 也可在 Generic Webhook Trigger 中额外配置 GITCODE_OWNER / GITCODE_REPO 变量
    def repoOwner = env.GITCODE_OWNER ?: ''
    def repoName  = env.GITCODE_REPO  ?: ''
    if ((!repoOwner || !repoName) && env.PR_REPO_URL) {
        def m = (env.PR_REPO_URL =~ /gitcode\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/)
        if (m.find()) {
            repoOwner = repoOwner ?: m.group(1)
            repoName  = repoName  ?: m.group(2)
        }
    }

    withEnv([
        "GITCODE_OWNER=${repoOwner}",
        "GITCODE_REPO=${repoName}",
        "GITCODE_API_BASE=${GITCODE_API_BASE}",
        "CI_LOG_DIR=${ciLogDir}",
        "PATH=${NODEJS_HOME}/bin:${env.PATH}"
    ]) {
        withCredentials([string(credentialsId: 'gitcode-api-token', variable: 'GITCODE_TOKEN')]) {

            timeout(time: 30, unit: 'MINUTES') {
                timestamps {
                    try {
                        stage('Checkout') {
                            checkout scm
                            // 配置带 token 的 remote URL，确保后续 git fetch 能认证
                            sh '''
                                REPO_URL="${PR_REPO_URL:-$(git remote get-url origin)}"
                                AUTH_URL=$(echo "${REPO_URL}" | sed "s|https://|https://oauth2:${GITCODE_TOKEN}@|")
                                git remote set-url origin "${AUTH_URL}"
                                git config user.email "ci@jenkins"
                                git config user.name "Jenkins CI"
                            '''
                        }

                        stage('Prepare') {
                            sh '''
                                echo "=== 环境检查 ==="
                                node --version || { echo "错误: node 未找到，请检查 NODEJS_HOME"; exit 1; }
                                npm --version
                                git --version

                                echo ""
                                echo "=== Webhook 变量检查 ==="
                                echo "GITCODE_OWNER   = ${GITCODE_OWNER:-<未设置>}"
                                echo "GITCODE_REPO    = ${GITCODE_REPO:-<未设置>}"
                                echo "PR_NUMBER       = ${PR_NUMBER:-<未设置>}"
                                echo "PR_SOURCE_BRANCH= ${PR_SOURCE_BRANCH:-<未设置>}"
                                echo "PR_TARGET_BRANCH= ${PR_TARGET_BRANCH:-<未设置>}"
                                echo "PR_COMMIT_SHA   = ${PR_COMMIT_SHA:-<未设置>}"
                                echo "PR_REPO_URL     = ${PR_REPO_URL:-<未设置>}"
                                echo "PR_SOURCE_REPO  = ${PR_SOURCE_REPO_URL:-<未设置>}"

                                if [ -z "${PR_NUMBER:-}" ] || [ -z "${PR_SOURCE_BRANCH:-}" ] || [ -z "${PR_TARGET_BRANCH:-}" ]; then
                                    echo ""
                                    echo "警告: Webhook 变量不完整，可能是手动触发或 Webhook 尚未配置。"
                                    echo "流水线将继续执行，但 GitCode API 回报和 PR merge 将被跳过。"
                                fi

                                mkdir -p "${CI_LOG_DIR}"
                            '''
                            sh 'bash ci/scripts/gitcode-notify.sh comment "⏳ CI 流水线已启动... [查看进度](${BUILD_URL})"'
                        }

                        def buildStatus = 'success'
                        def testStatus = 'skipped'

                        stage('Build') {
                            echo "=== Stage: Build ==="

                            try {
                                sh '''#!/usr/bin/env bash
                                    set -euo pipefail

                                    if [ -n "${PR_NUMBER:-}" ] && [ -n "${PR_SOURCE_BRANCH:-}" ] && [ -n "${PR_TARGET_BRANCH:-}" ]; then
                                        echo "PR #${PR_NUMBER}: ${PR_SOURCE_BRANCH} → ${PR_TARGET_BRANCH}"

                                        # 拉取目标分支
                                        git fetch origin "${PR_TARGET_BRANCH}"
                                        git checkout -B "ci-merge-${PR_NUMBER}" "origin/${PR_TARGET_BRANCH}"

                                        # 如果有源仓库 URL（fork 场景），添加为临时 remote
                                        if [ -n "${PR_SOURCE_REPO_URL:-}" ]; then
                                            SOURCE_AUTH_URL=$(echo "${PR_SOURCE_REPO_URL}" | sed "s|https://|https://oauth2:${GITCODE_TOKEN}@|")
                                            git remote remove pr-source 2>/dev/null || true
                                            git remote add pr-source "${SOURCE_AUTH_URL}"
                                            git fetch pr-source "${PR_SOURCE_BRANCH}"
                                            git merge --no-ff "pr-source/${PR_SOURCE_BRANCH}" \
                                                -m "CI: merge PR #${PR_NUMBER} (${PR_SOURCE_BRANCH}) into ${PR_TARGET_BRANCH}"
                                        else
                                            git fetch origin "${PR_SOURCE_BRANCH}"
                                            git merge --no-ff "origin/${PR_SOURCE_BRANCH}" \
                                                -m "CI: merge PR #${PR_NUMBER} (${PR_SOURCE_BRANCH}) into ${PR_TARGET_BRANCH}"
                                        fi
                                    else
                                        echo "Webhook 变量不完整，跳过 PR merge，直接在当前分支构建"
                                    fi

                                    rm -rf dist || true
                                    npm install 2>&1 | tee "${CI_LOG_DIR}/npm-install.log"
                                    npm run build-cli 2>&1 | tee "${CI_LOG_DIR}/build.log"

                                    echo "success" > "${CI_LOG_DIR}/build.status"
                                '''
                                archiveArtifacts artifacts: 'dist/cli/*', allowEmptyArchive: true, fingerprint: true
                            } catch (e) {
                                buildStatus = 'failure'
                                sh 'echo "failure" > "${CI_LOG_DIR}/build.status"'
                                throw e
                            }
                        }

                        stage('Test') {
                            echo "=== Stage: Test ==="

                            if (buildStatus == 'success') {
                                try {
                                    sh '''#!/usr/bin/env bash
                                        set -euo pipefail

                                        {
 	                                        echo "=== docs freshness check ==="
 	                                        npm run check:docs
 	                                        echo ""
 	                                        echo "=== unit tests ==="
 	                                        npm run test:unit -- \
 	                                          --json \
 	                                          --outputFile "${CI_LOG_DIR}/jest-unit-results.json"
 	                                    } 2>&1 | tee "${CI_LOG_DIR}/test.log"
                                    '''
                                    testStatus = 'success'
                                    sh 'echo "success" > "${CI_LOG_DIR}/test.status"'
                                } catch (e) {
                                    testStatus = 'failure'
                                    sh 'echo "failure" > "${CI_LOG_DIR}/test.status"'
                                    buildResult = 'failure'
                                    currentBuild.result = 'FAILURE'
                                }
                            } else {
                                testStatus = 'skipped'
                                sh 'echo "skipped" > "${CI_LOG_DIR}/test.status"'
                            }
                        }

                    } catch (err) {
                        buildResult = 'failure'
                        currentBuild.result = 'FAILURE'
                        echo "Pipeline 失败: ${err.getMessage()}"

                    } finally {
                        // ── 回报结果到 GitCode（始终在 node 上下文内） ──
                        stage('Report') {
                            if (buildResult == 'success') {
                                sh 'bash ci/scripts/gitcode-notify.sh comment-with-logs success'
                            } else {
                                sh 'bash ci/scripts/gitcode-notify.sh comment-with-logs failure'
                            }
                        }

                        // ── 清理环境 ──
                        stage('Cleanup') {
                            sh '''
                                echo "=== 清理构建环境 ==="

                                rm -rf dist || true

                                git remote remove pr-source 2>/dev/null || true
                                if [ -n "${PR_NUMBER:-}" ]; then
                                    git checkout --detach HEAD 2>/dev/null || true
                                    git branch -D "ci-merge-${PR_NUMBER}" 2>/dev/null || true
                                fi

                                rm -rf "${CI_LOG_DIR}" || true

                                echo "环境清理完成"
                            '''
                        }
                    }
                }
            }

        }
    }
}
