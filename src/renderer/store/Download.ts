import {EventEmitter} from 'events'
import {autorun, makeAutoObservable, makeObservable, observable} from 'mobx'
import {persist} from 'mobx-persist'
import path from 'path'
import Task, {TaskStatus} from './AbstractTask'
import {fileDownUrl, pwdFileDownUrl} from '../../common/core/download'
import {delay, isSpecificFile, restoreFileName, sizeToByte, streamToText} from '../../common/util'
import {lsShare, URLType} from '../../common/core/ls'
import merge from '../../common/merge'
import store from '../../common/store'
import {message} from '../component/Message'
import * as http from '../../common/http'

import fs from 'fs-extra'
import {Progress} from 'got/dist/source/core'
import {pipeline} from 'stream/promises'
import {Request} from 'got'
import {Matcher} from '../../common/core/matcher'

export interface DownloadSubTask {
  url: string
  pwd?: string
  dir: string // 临时地址
  name: string // 真实名称
  resolve: number
  status: TaskStatus
  size: number
}

/**
 * 1. 文件：获取 url
 * 2. 文件夹：
 */
export class DownloadTask {
  // 分享链接
  url: string
  // 任务类型，文件 | 文件夹 (初始化 task 的时候赋值)
  urlType: URLType
  // 文件名（真实名称）
  name: string
  // 文件下载保存的地址（真实地址）
  dir: string
  // 分享链接的密码
  pwd?: string
  // 自定合并 tasks 的文件。如果需要合并，则会创建 文件名+.download 的临时文件夹
  merge?: boolean

  tasks: DownloadSubTask[] = []

  constructor(props: Partial<DownloadTask> = {}) {
    makeAutoObservable(this)
    Object.assign(this, props)
  }

  get total() {
    return this.tasks.reduce((total, item) => total + item.size, 0)
  }

  get resolve() {
    return this.tasks.reduce((total, item) => total + item.resolve, 0)
  }

  get status() {
    if (this.tasks.some(item => item.status === TaskStatus.pending)) return TaskStatus.pending
    return TaskStatus.ready
  }
}

export interface Download {
  on(event: 'finish', listener: (info: DownloadTask) => void): this
  on(event: 'finish-task', listener: (info: DownloadTask, task: DownloadSubTask) => void): this
  // on(event: 'error', listener: (msg: string) => void): this

  removeListener(event: 'finish', listener: (info: DownloadTask) => void): this
  removeListener(event: 'finish-task', listener: (info: DownloadTask, task: DownloadSubTask) => void): this
  // removeListener(event: 'error', listener: (msg: string) => void): this

  emit(event: 'finish', info: DownloadTask)
  emit(event: 'finish-task', info: DownloadTask, task: DownloadSubTask)
  // emit(event: 'error', msg: string)
}

export class Download extends EventEmitter implements Task<DownloadTask> {
  handler: ReturnType<typeof autorun>
  taskSignal: {[taskUrl: string]: AbortController} = {}
  @persist('list') list: DownloadTask[] = []
  @persist('list') finishList: DownloadTask[] = []
  @persist dir = ''

  get queue() {
    return this.getList(item => item.status === TaskStatus.pending).length
  }

  constructor() {
    super()
    makeObservable(this, {
      list: observable,
      finishList: observable,
      dir: observable,
    })

    process.nextTick(this.init)
  }

  private init = () => {
    if (!this.dir) {
      this.dir = store.get('downloads')
    }

    this.startQueue()
    this.on('finish', info => {
      delay(200).then(() => this.onTaskFinish(info))
      this.remove(info.url)
      this.finishList.push(info)
    })
    this.on('finish-task', (info, task) => {
      delete this.taskSignal[task.url]
      if (info.tasks.every(item => item.status === TaskStatus.finish)) {
        this.emit('finish', info)
      } else {
        this.start(info.url)
      }
    })
  }

  async onTaskFinish(task: DownloadTask) {
    const resolveTarget = path.join(task.dir, task.name)
    const subTask = task.tasks[0]
    switch (task.urlType) {
      case URLType.file:
        await fs.rename(path.join(subTask.dir, subTask.name), resolveTarget)
        await fs.remove(subTask.dir)
        break
      case URLType.folder:
        if (task.merge) {
          // 读取目录下文件（会自动排序）
          const files = (await fs.readdir(subTask.dir)).map(name => path.join(subTask.dir, name))
          // 合并后删除
          await merge(files, resolveTarget)
          await delay(200)
          await fs.remove(subTask.dir)
        } else {
          // 重命名
          await fs.rename(subTask.dir, subTask.dir.replace(/\.downloading$/, ''))
        }
        break
    }
  }

  startQueue() {
    this.handler = autorun(
      () => {
        this.list.length && this.checkTask()
      },
      {delay: 300}
    )
  }

  stopQueue() {
    this.handler?.()
    this.handler = null
  }

  checkTask() {
    const url = this.list.find(item => item.status === TaskStatus.ready)?.url
    if (url) {
      this.start(url)
    }
  }

  getList(filter: (item: DownloadSubTask) => boolean) {
    return this.list
      .map(item => item.tasks)
      .flat()
      .filter(filter)
  }

  canStart(task: DownloadTask) {
    return this.queue < 3 // && info.status !== InitStatus.pending
  }

  abortTask = (task: DownloadSubTask) => {
    return new Promise<void>(resolve => {
      if (this.taskSignal[task.url]) {
        this.taskSignal[task.url].abort()
        delete this.taskSignal[task.url]
        // electron.ipcRenderer.once(`${IpcEvent.cancelled}${task.url}`, () => resolve())
      } else {
        resolve()
      }
    })
  }

  async pause(url: string) {
    await Promise.all(
      this.list
        .find(item => item.url === url)
        ?.tasks?.map(task => {
          if ([TaskStatus.ready, TaskStatus.pending].includes(task.status)) {
            task.status = TaskStatus.pause
            return this.abortTask(task)
          }
          return Promise.resolve()
        }) ?? []
    )
  }

  pauseAll() {
    this.list.forEach(item => this.pause(item.url))
  }

  remove(url: string) {
    this.list.find(item => item.url === url)?.tasks?.forEach(this.abortTask)
    this.list = this.list.filter(item => item.url !== url)
  }

  removeAll() {
    this.list.forEach(info => info.tasks.forEach(this.abortTask))
    this.list = []
  }

  removeAllFinish() {
    this.finishList = []
  }

  /**
   *
   * reset 从暂停恢复下载状态，传 true
   */
  async start(url: string, reset = false) {
    const task = this.list.find(value => value.url === url)
    if (!task) return
    if (!this.canStart(task)) return

    if (!task.tasks?.length) {
      await this.initTask(task)
    } else if (reset) {
      task.tasks.forEach(value => {
        if ([TaskStatus.pause, TaskStatus.fail].includes(value.status)) {
          value.status = TaskStatus.ready
        }
      })
    }

    // todo: 只能查找 TaskStatus.ready 的任务？
    const subTask = task.tasks.find(value => value.status === TaskStatus.ready)
    if (!subTask) return

    subTask.status = TaskStatus.pending

    try {
      const {url: downloadUrl} = subTask.pwd
        ? await pwdFileDownUrl(subTask.url, subTask.pwd)
        : await fileDownUrl(subTask.url)

      await fs.ensureDir(subTask.dir)

      const stream = await this.createStream(downloadUrl)
      const headers = stream.response.headers
      if (headers['content-disposition']) {
        // todo: 在这里更新 subTask 的 content-length ?
        subTask.size = Number(headers['content-length'])
      }
      stream.on('downloadProgress', (progress: Progress) => {
        // TODO：限制触发频率
        console.log(progress)
        subTask.resolve = progress.transferred
      })

      const abort = new AbortController()
      this.taskSignal[task.url] = abort

      await pipeline(
        // 流下载
        stream,
        fs.createWriteStream(path.join(subTask.dir, subTask.name)),
        {signal: abort.signal}
      )
      subTask.status = TaskStatus.finish
      this.emit('finish-task', task, subTask)
    } catch (e: any) {
      message.error(e)
      if (this.taskSignal[task.url]?.signal?.aborted) {
        subTask.status = TaskStatus.pause
      } else {
        subTask.status = TaskStatus.fail
      }
    }
  }

  createStream(downloadUrl: string) {
    return new Promise<Request>((resolve, reject) => {
      const stream = http.share.stream(downloadUrl)
      stream
        .once('response', async (response: typeof stream.response) => {
          // 下载环境异常会跳转到验证页面
          if (response.headers['content-type'] === 'text/html') {
            // 解析下载验证页面
            const html = await streamToText(stream)
            const ajaxData = Matcher.parseValidateAjax(html)
            if (ajaxData) {
              await delay(2000) // important! 模拟验证页面的延时，去掉会导致验证失败！
              const {url} = await http
                .share(new URL(ajaxData.url, downloadUrl), {
                  method: ajaxData.type,
                  headers: {referer: downloadUrl},
                  form: ajaxData.data,
                })
                .json<{url: string}>()
              resolve(this.createStream(url))
            } else {
              reject('下载验证页面解析出错')
            }
          } else {
            resolve(stream)
          }
        })
        .once('error', err => {
          reject(err.message)
        })
    })
  }

  async initTask(task: DownloadTask) {
    if (task.tasks?.length) return
    const {name, type, list} = await lsShare(task)
    task.urlType = type
    if (!task.name) {
      task.name = name
    }

    const dir = path.join(task.dir, task.name) + '.downloading'
    task.tasks = list.map(value => {
      const name = !task.merge && isSpecificFile(value.name) ? restoreFileName(value.name) : value.name

      return {
        url: value.url,
        pwd: value.pwd,
        dir,
        name: name,
        size: sizeToByte(value.size),
        resolve: 0,
        status: TaskStatus.ready,
      }
    })
  }

  startAll() {
    this.list.forEach(info => {
      info.tasks.forEach(task => {
        if (task.status === TaskStatus.pause) {
          task.status = TaskStatus.ready
        }
      })

      this.start(info.url)
    })
  }

  // 下载前检查：1.是否在下载列表；2.文件是否存在
  private async pushAndCheckList(task: DownloadTask) {
    if (this.list.find(value => value.url === task.url)) {
      message.info('文件已存在下载列表！')
      throw new Error('文件已存在下载列表!')
    }

    const name = restoreFileName(path.join(task.dir, task.name))
    if (fs.existsSync(name)) {
      const result = confirm('文件已存在，是否删除并重新下载？')
      if (!result) {
        throw new Error('取消重新下载')
      }

      await fs.remove(name)
    }
    this.list.push(task)
  }

  /**
   * 先不解析，开始下载时再解析
   * name, url, pwd?, merge?
   */
  addTask(options: {
    name: string // 分享链接的下载全部没有 name
    url: string
    pwd?: string
    merge?: boolean
  }) {
    // name 加后缀最长 104
    const task = new DownloadTask()
    task.name = isSpecificFile(options.name) ? restoreFileName(options.name) : options.name
    task.url = options.url
    task.pwd = options.pwd
    task.merge = options.merge
    task.dir = this.dir

    this.pushAndCheckList(task)
  }
}
