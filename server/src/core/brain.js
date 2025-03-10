import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { langs } from '@@/core/langs.json'
import { HAS_TTS } from '@/constants'
import { LangHelper } from '@/helpers/lang-helper'
import { LogHelper } from '@/helpers/log-helper'
import { SkillDomainHelper } from '@/helpers/skill-domain-helper'
import { StringHelper } from '@/helpers/string-helper'
import Synchronizer from '@/core/synchronizer'

class Brain {
  constructor() {
    this._lang = 'en'
    this.broca = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'core/data', this._lang, 'answers.json'),
        'utf8'
      )
    )
    this.process = {}
    this.interOutput = {}
    this.finalOutput = {}
    this._socket = {}
    this._stt = {}
    this._tts = {}

    LogHelper.title('Brain')
    LogHelper.success('New instance')
  }

  get socket() {
    return this._socket
  }

  set socket(newSocket) {
    this._socket = newSocket
  }

  get stt() {
    return this._stt
  }

  set stt(newStt) {
    this._stt = newStt
  }

  get tts() {
    return this._tts
  }

  set tts(newTts) {
    this._tts = newTts
  }

  get lang() {
    return this._lang
  }

  set lang(newLang) {
    this._lang = newLang
    // Update broca
    this.broca = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'core/data', this._lang, 'answers.json'),
        'utf8'
      )
    )

    if (HAS_TTS) {
      this._tts.init(this._lang, () => {
        LogHelper.title('Brain')
        LogHelper.info('Language has changed')
      })
    }
  }

  /**
   * Delete intent object file
   */
  static deleteIntentObjFile(intentObjectPath) {
    try {
      if (fs.existsSync(intentObjectPath)) {
        fs.unlinkSync(intentObjectPath)
      }
    } catch (e) {
      LogHelper.error(`Failed to delete intent object file: ${e}`)
    }
  }

  /**
   * Make Leon talk
   */
  talk(rawSpeech, end = false) {
    LogHelper.title('Leon')
    LogHelper.info('Talking...')

    if (rawSpeech !== '') {
      if (HAS_TTS) {
        // Stripe HTML to a whitespace. Whitespace to let the TTS respects punctuation
        const speech = rawSpeech.replace(/<(?:.|\n)*?>/gm, ' ')

        this._tts.add(speech, end)
      }

      this._socket.emit('answer', rawSpeech)
    }
  }

  /**
   * Pickup speech info we need to return
   */
  wernicke(type, key, obj) {
    let answer = ''

    // Choose a random answer or a specific one
    const property = this.broca.answers[type]
    if (property.constructor === [].constructor) {
      answer = property[Math.floor(Math.random() * property.length)]
    } else {
      answer = property
    }

    // Select a specific key
    if (key !== '' && typeof key !== 'undefined') {
      answer = answer[key]
    }

    // Parse sentence's value(s) and replace with the given object
    if (typeof obj !== 'undefined' && Object.keys(obj).length > 0) {
      answer = StringHelper.findAndMap(answer, obj)
    }

    return answer
  }

  /**
   * Execute Python skills
   * TODO: split into several methods
   */
  execute(obj, opts) {
    const executionTimeStart = Date.now()
    opts = opts || {
      mute: false // Close Leon mouth e.g. over HTTP
    }

    return new Promise(async (resolve, reject) => {
      const utteranceId = `${Date.now()}-${StringHelper.random(4)}`
      const intentObjectPath = path.join(
        __dirname,
        `../tmp/${utteranceId}.json`
      )
      const speeches = []

      // Ask to repeat if Leon is not sure about the request
      if (
        obj.classification.confidence <
        langs[LangHelper.getLongCode(this._lang)].min_confidence
      ) {
        if (!opts.mute) {
          const speech = `${this.wernicke('random_not_sure')}.`

          speeches.push(speech)
          this.talk(speech, true)
          this._socket.emit('is-typing', false)
        }

        const executionTimeEnd = Date.now()
        const executionTime = executionTimeEnd - executionTimeStart

        resolve({
          speeches,
          executionTime
        })
      } else {
        const {
          configDataFilePath,
          classification: { action: actionName }
        } = obj
        const { actions } = JSON.parse(
          fs.readFileSync(configDataFilePath, 'utf8')
        )
        const action = actions[actionName]
        const { type: actionType } = action
        const nextAction = action.next_action
          ? actions[action.next_action]
          : null

        if (actionType === 'logic') {
          /**
           * "Logic" action skill execution
           */

          // Ensure the process is empty (to be able to execute other processes outside of Brain)
          if (Object.keys(this.process).length === 0) {
            /**
             * Execute a skill in a standalone way (CLI):
             *
             * 1. Need to be at the root of the project
             * 2. Edit: server/src/intent-object.sample.json
             * 3. Run: PIPENV_PIPFILE=bridges/python/Pipfile pipenv run
             *    python bridges/python/main.py server/src/intent-object.sample.json
             */
            const slots = {}
            if (obj.slots) {
              Object.keys(obj.slots)?.forEach((slotName) => {
                slots[slotName] = obj.slots[slotName].value
              })
            }
            const intentObj = {
              id: utteranceId,
              lang: this._lang,
              domain: obj.classification.domain,
              skill: obj.classification.skill,
              action: obj.classification.action,
              utterance: obj.utterance,
              current_entities: obj.currentEntities,
              entities: obj.entities,
              current_resolvers: obj.currentResolvers,
              resolvers: obj.resolvers,
              slots
            }

            try {
              fs.writeFileSync(intentObjectPath, JSON.stringify(intentObj))
              this.process = spawn(
                `pipenv run python bridges/python/main.py ${intentObjectPath}`,
                { shell: true }
              )
            } catch (e) {
              LogHelper.error(`Failed to save intent object: ${e}`)
            }
          }

          const domainName = obj.classification.domain
          const skillName = obj.classification.skill
          const { name: domainFriendlyName } =
            SkillDomainHelper.getSkillDomainInfo(domainName)
          const { name: skillFriendlyName } = SkillDomainHelper.getSkillInfo(
            domainName,
            skillName
          )
          let output = ''

          // Read output
          this.process.stdout.on('data', (data) => {
            const executionTimeEnd = Date.now()
            const executionTime = executionTimeEnd - executionTimeStart

            try {
              const obj = JSON.parse(data.toString())

              if (typeof obj === 'object') {
                if (obj.output.type === 'inter') {
                  LogHelper.title(`${skillFriendlyName} skill`)
                  LogHelper.info(data.toString())

                  this.interOutput = obj.output

                  const speech = obj.output.speech.toString()
                  if (!opts.mute) {
                    this.talk(speech)
                  }
                  speeches.push(speech)
                } else {
                  output += data
                }
              } else {
                /* istanbul ignore next */
                reject({
                  type: 'warning',
                  obj: new Error(
                    `The "${skillFriendlyName}" skill from the "${domainFriendlyName}" domain is not well configured. Check the configuration file.`
                  ),
                  speeches,
                  executionTime
                })
              }
            } catch (e) {
              LogHelper.title('Brain')
              LogHelper.debug(`process.stdout: ${String(data)}`)

              /* istanbul ignore next */
              reject({
                type: 'error',
                obj: new Error(
                  `The "${skillFriendlyName}" skill from the "${domainFriendlyName}" domain isn't returning JSON format.`
                ),
                speeches,
                executionTime
              })
            }
          })

          // Handle error
          this.process.stderr.on('data', (data) => {
            const speech = `${this.wernicke('random_skill_errors', '', {
              '%skill_name%': skillFriendlyName,
              '%domain_name%': domainFriendlyName
            })}!`
            if (!opts.mute) {
              this.talk(speech)
              this._socket.emit('is-typing', false)
            }
            speeches.push(speech)

            Brain.deleteIntentObjFile(intentObjectPath)

            LogHelper.title(`${skillFriendlyName} skill`)
            LogHelper.error(data.toString())

            const executionTimeEnd = Date.now()
            const executionTime = executionTimeEnd - executionTimeStart
            reject({
              type: 'error',
              obj: new Error(data),
              speeches,
              executionTime
            })
          })

          // Catch the end of the skill execution
          this.process.stdout.on('end', () => {
            LogHelper.title(`${skillFriendlyName} skill`)
            LogHelper.info(output)

            this.finalOutput = output

            // Check if there is an output (no skill error)
            if (this.finalOutput !== '') {
              this.finalOutput = JSON.parse(this.finalOutput).output

              let { speech } = this.finalOutput
              if (speech) {
                speech = speech.toString()
                if (!opts.mute) {
                  this.talk(speech, true)
                }
                speeches.push(speech)

                /* istanbul ignore next */
                // Synchronize the downloaded content if enabled
                if (
                  this.finalOutput.type === 'end' &&
                  this.finalOutput.options.synchronization &&
                  this.finalOutput.options.synchronization.enabled &&
                  this.finalOutput.options.synchronization.enabled === true
                ) {
                  const sync = new Synchronizer(
                    this,
                    obj.classification,
                    this.finalOutput.options.synchronization
                  )

                  // When the synchronization is finished
                  sync.synchronize((speech) => {
                    if (!opts.mute) {
                      this.talk(speech)
                    }
                    speeches.push(speech)
                  })
                }
              }
            }

            Brain.deleteIntentObjFile(intentObjectPath)

            if (!opts.mute) {
              this._socket.emit('is-typing', false)
            }

            const executionTimeEnd = Date.now()
            const executionTime = executionTimeEnd - executionTimeStart

            // Send suggestions to the client
            if (
              nextAction?.suggestions &&
              this.finalOutput.core?.showNextActionSuggestions
            ) {
              this._socket.emit('suggest', nextAction.suggestions)
            }
            if (action?.suggestions && this.finalOutput.core?.showSuggestions) {
              this._socket.emit('suggest', action.suggestions)
            }

            resolve({
              utteranceId,
              lang: this._lang,
              ...obj,
              speeches,
              core: this.finalOutput.core,
              action,
              nextAction,
              executionTime // In ms, skill execution time only
            })
          })

          // Reset the child process
          this.process = {}
        } else {
          /**
           * "Dialog" action skill execution
           */

          const configFilePath = path.join(
            process.cwd(),
            'skills',
            obj.classification.domain,
            obj.classification.skill,
            'config',
            `${this._lang}.json`
          )
          const { actions, entities } = await SkillDomainHelper.getSkillConfig(
            configFilePath,
            this._lang
          )
          const utteranceHasEntities = obj.entities.length > 0
          const { answers: rawAnswers } = obj
          let answers = rawAnswers
          let answer = ''

          if (!utteranceHasEntities) {
            answers = answers.filter(
              ({ answer }) => answer.indexOf('{{') === -1
            )
          } else {
            answers = answers.filter(
              ({ answer }) => answer.indexOf('{{') !== -1
            )
          }

          // When answers are simple without required entity
          if (answers.length === 0) {
            answer =
              rawAnswers[Math.floor(Math.random() * rawAnswers.length)]?.answer

            // In case the expected answer requires a known entity
            if (answer.indexOf('{{') !== -1) {
              // TODO
              answers = actions[obj.classification.action]?.unknown_answers
              answer = answers[Math.floor(Math.random() * answers.length)]
            }
          } else {
            answer = answers[Math.floor(Math.random() * answers.length)]?.answer

            /**
             * In case the utterance contains entities, and the picked up answer too,
             * then map them (utterance <-> answer)
             */
            if (utteranceHasEntities && answer.indexOf('{{') !== -1) {
              obj.currentEntities.forEach((entityObj) => {
                answer = StringHelper.findAndMap(answer, {
                  [`{{ ${entityObj.entity} }}`]: entityObj.resolution.value
                })

                // Find matches and map deeper data from the NLU file (global entities)
                const matches = answer.match(/{{.+?}}/g)

                matches?.forEach((match) => {
                  let newStr = match.substring(3)

                  newStr = newStr.substring(0, newStr.indexOf('}}') - 1)

                  const [entity, dataKey] = newStr.split('.')

                  if (entity === entityObj.entity) {
                    // e.g. entities.color.options.red.data.usage
                    const valuesArr =
                      entities[entity].options[entityObj.option].data[dataKey]

                    answer = StringHelper.findAndMap(answer, {
                      [match]:
                        valuesArr[Math.floor(Math.random() * valuesArr.length)]
                    })
                  }
                })
              })
            }
          }

          const executionTimeEnd = Date.now()
          const executionTime = executionTimeEnd - executionTimeStart

          if (!opts.mute) {
            this.talk(answer, true)
            this._socket.emit('is-typing', false)
          }

          // Send suggestions to the client
          if (nextAction?.suggestions) {
            this._socket.emit('suggest', nextAction.suggestions)
          }

          resolve({
            utteranceId,
            lang: this._lang,
            ...obj,
            speeches: [answer],
            core: this.finalOutput.core,
            action,
            nextAction,
            executionTime // In ms, skill execution time only
          })
        }
      }
    })
  }
}

export default Brain
