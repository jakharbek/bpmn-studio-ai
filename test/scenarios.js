// Realistic process specs used by the test suite (and for visual checks).
const S = (id, type, name, extra = {}) => ({ id, type, ...(name ? { name } : {}), ...extra });
const F = (from, to, extra = {}) => ({ from, to, ...extra });

export const scenarios = {
  // Order handling: message start, service tasks, XOR split/merge, user task with timer boundary,
  // embedded multi-instance sub-process.
  order: {
    processId: 'order-process', processName: 'Обработка заказа', platform: 'camunda8',
    elements: [
      S('Start', 'startEvent', 'Заказ получен', { eventDefinition: 'message', messageName: 'OrderReceived' }),
      S('Task_CheckStock', 'serviceTask', 'Проверить склад', { jobType: 'check-stock', inputs: [{ source: '=order.id', target: 'orderId' }] }),
      S('Gateway_InStock', 'exclusiveGateway', 'Товар в наличии?'),
      S('Task_Approve', 'userTask', 'Одобрить заказ', { assignee: 'manager', candidateGroups: 'sales', formId: 'approve-order' }),
      S('Timer_Approve', 'boundaryEvent', '24 часа', { attachedTo: 'Task_Approve', eventDefinition: 'timer', timerValue: 'PT24H' }),
      S('Task_Escalate', 'sendTask', 'Уведомить руководителя', { jobType: 'notify-head' }),
      S('Sub_Delivery', 'subProcess', 'Доставка'),
      S('Sub_Start', 'startEvent', 'Доставка начата', { parent: 'Sub_Delivery' }),
      S('Task_Ship', 'serviceTask', 'Отгрузить позицию', { parent: 'Sub_Delivery', jobType: 'ship', multiInstance: { collection: '=items', element: 'item' } }),
      S('Sub_End', 'endEvent', 'Доставка завершена', { parent: 'Sub_Delivery' }),
      S('Gateway_Merge', 'exclusiveGateway'),
      S('End_Done', 'endEvent', 'Заказ выполнен'),
      S('End_Rejected', 'endEvent', 'Заказ отклонён')
    ],
    flows: [
      F('Start', 'Task_CheckStock'), F('Task_CheckStock', 'Gateway_InStock'),
      F('Gateway_InStock', 'Task_Approve', { name: 'Да', condition: 'inStock = true' }),
      F('Gateway_InStock', 'End_Rejected', { name: 'Нет', isDefault: true }),
      F('Task_Approve', 'Gateway_Merge'), F('Timer_Approve', 'Task_Escalate'), F('Task_Escalate', 'Gateway_Merge'),
      F('Gateway_Merge', 'Sub_Delivery'), F('Sub_Delivery', 'End_Done'),
      F('Sub_Start', 'Task_Ship'), F('Task_Ship', 'Sub_End')
    ]
  },

  // Parallel split/join + rework loop.
  parallelLoop: {
    processId: 'doc-review', processName: 'Согласование документа', platform: 'camunda8',
    elements: [
      S('Start', 'startEvent', 'Документ создан'),
      S('Split', 'parallelGateway'),
      S('Task_Legal', 'userTask', 'Проверить юристом', { candidateGroups: 'legal', formId: 'review' }),
      S('Task_Finance', 'userTask', 'Проверить финансистом', { candidateGroups: 'finance', formId: 'review' }),
      S('Join', 'parallelGateway'),
      S('Gateway_Ok', 'exclusiveGateway', 'Все согласовали?'),
      S('Task_Fix', 'userTask', 'Доработать документ', { assignee: '=author', formId: 'fix' }),
      S('Gateway_Loop', 'exclusiveGateway'),
      S('End', 'endEvent', 'Документ согласован')
    ],
    flows: [
      F('Start', 'Gateway_Loop'), F('Gateway_Loop', 'Split'),
      F('Split', 'Task_Legal'), F('Split', 'Task_Finance'), F('Task_Legal', 'Join'), F('Task_Finance', 'Join'),
      F('Join', 'Gateway_Ok'),
      F('Gateway_Ok', 'End', { name: 'Да', condition: 'legalOk and financeOk' }),
      F('Gateway_Ok', 'Task_Fix', { name: 'Нет', isDefault: true }),
      F('Task_Fix', 'Gateway_Loop')
    ]
  },

  // Event-based gateway, receive task, intermediate message/timer catch.
  eventBased: {
    processId: 'payment-wait', processName: 'Ожидание оплаты', platform: 'camunda8',
    elements: [
      S('Start', 'startEvent', 'Счёт выставлен'),
      S('Task_Send', 'sendTask', 'Отправить счёт', { jobType: 'send-invoice' }),
      S('EBG', 'eventBasedGateway'),
      S('Msg_Paid', 'intermediateCatchEvent', 'Оплата получена', { eventDefinition: 'message', messageName: 'PaymentReceived', correlationKey: 'invoiceId' }),
      S('Timer_3d', 'intermediateCatchEvent', '3 дня', { eventDefinition: 'timer', timerValue: 'P3D' }),
      S('Task_Wait', 'receiveTask', 'Дождаться подтверждения банка', { messageName: 'BankConfirmation', correlationKey: '=invoiceId' }),
      S('End_Paid', 'endEvent', 'Оплачено'),
      S('End_Cancel', 'endEvent', 'Счёт аннулирован')
    ],
    flows: [
      F('Start', 'Task_Send'), F('Task_Send', 'EBG'), F('EBG', 'Msg_Paid'), F('EBG', 'Timer_3d'),
      F('Msg_Paid', 'Task_Wait'), F('Task_Wait', 'End_Paid'), F('Timer_3d', 'End_Cancel')
    ]
  },

  // Event sub-processes (interrupting error, non-interrupting message), error end event,
  // call activity, business rule task, script task, Cyrillic message names.
  eventSub: {
    processId: 'loan', processName: 'Выдача кредита', platform: 'camunda8',
    elements: [
      S('Start', 'startEvent', 'Заявка подана'),
      S('Task_Score', 'businessRuleTask', 'Рассчитать скоринг', { decisionId: 'scoring', resultVariable: 'score' }),
      S('Task_Calc', 'scriptTask', 'Рассчитать лимит', { script: 'score * 1000', resultVariable: 'limit' }),
      S('Call_Kyc', 'callActivity', 'Проверить клиента (KYC)', { calledElement: 'kyc-process' }),
      S('Gateway_Kyc', 'exclusiveGateway', 'KYC пройден?'),
      S('End_Ok', 'endEvent', 'Кредит выдан'),
      S('End_Fraud', 'endEvent', 'Мошенничество', { eventDefinition: 'error', errorCode: 'FRAUD', errorName: 'Мошенничество' }),
      S('ESub_Error', 'subProcess', 'Обработка мошенничества', { triggeredByEvent: true }),
      S('ESub_Error_Start', 'startEvent', 'Мошенничество выявлено', { parent: 'ESub_Error', eventDefinition: 'error', errorCode: 'FRAUD', errorName: 'Мошенничество' }),
      S('Task_Block', 'serviceTask', 'Заблокировать клиента', { parent: 'ESub_Error', jobType: 'block-client' }),
      S('ESub_Error_End', 'endEvent', 'Клиент заблокирован', { parent: 'ESub_Error' }),
      S('ESub_Msg', 'subProcess', 'Запрос статуса', { triggeredByEvent: true }),
      S('ESub_Msg_Start', 'startEvent', 'Клиент запросил статус', { parent: 'ESub_Msg', eventDefinition: 'message', messageName: 'Запрос статуса', correlationKey: 'applicationId', interrupting: false }),
      S('Task_Status', 'serviceTask', 'Отправить статус', { parent: 'ESub_Msg', jobType: 'send-status' }),
      S('ESub_Msg_End', 'endEvent', 'Статус отправлен', { parent: 'ESub_Msg' })
    ],
    flows: [
      F('Start', 'Task_Score'), F('Task_Score', 'Task_Calc'), F('Task_Calc', 'Call_Kyc'), F('Call_Kyc', 'Gateway_Kyc'),
      F('Gateway_Kyc', 'End_Ok', { name: 'Да', condition: 'kycPassed' }),
      F('Gateway_Kyc', 'End_Fraud', { name: 'Нет', isDefault: true }),
      F('ESub_Error_Start', 'Task_Block'), F('Task_Block', 'ESub_Error_End'),
      F('ESub_Msg_Start', 'Task_Status'), F('Task_Status', 'ESub_Msg_End')
    ]
  },

  // Timer start (cycle), signal throw, escalation, link events.
  timerSignal: {
    processId: 'nightly', processName: 'Ночная выгрузка', platform: 'camunda8',
    elements: [
      S('Start', 'startEvent', 'Каждую ночь', { eventDefinition: 'timer', timerType: 'cycle', timerValue: 'R/2026-01-01T02:00:00Z/P1D' }),
      S('Task_Export', 'serviceTask', 'Выгрузить данные', { jobType: 'export', retries: 5, headers: { target: 's3' } }),
      S('Link_Throw', 'intermediateThrowEvent', 'К уведомлению', { eventDefinition: 'link', linkName: 'notify' }),
      S('Link_Catch', 'intermediateCatchEvent', 'К уведомлению', { eventDefinition: 'link', linkName: 'notify' }),
      S('Signal_Done', 'intermediateThrowEvent', 'Выгрузка готова', { eventDefinition: 'signal', signalName: 'ExportDone' }),
      S('End', 'endEvent', 'Готово')
    ],
    flows: [F('Start', 'Task_Export'), F('Task_Export', 'Link_Throw'), F('Link_Catch', 'Signal_Done'), F('Signal_Done', 'End')]
  },

  // Camunda 7 flavour.
  camunda7: {
    processId: 'vacation', processName: 'Заявка на отпуск', platform: 'camunda7',
    elements: [
      S('Start', 'startEvent', 'Заявка создана', { formKey: 'embedded:app:forms/start.html' }),
      S('Task_Approve', 'userTask', 'Согласовать отпуск', { candidateGroups: 'managers', formKey: 'embedded:app:forms/approve.html' }),
      S('Gateway', 'exclusiveGateway', 'Одобрено?'),
      S('Task_Book', 'serviceTask', 'Оформить приказ', { jobType: 'hr-order' }),
      S('Task_Notify', 'serviceTask', 'Уведомить сотрудника', { delegateExpression: '${notifyDelegate}' }),
      S('End_Ok', 'endEvent', 'Отпуск оформлен'),
      S('End_No', 'endEvent', 'Отказано')
    ],
    flows: [
      F('Start', 'Task_Approve'), F('Task_Approve', 'Gateway'),
      F('Gateway', 'Task_Book', { name: 'Да', condition: 'approved' }),
      F('Gateway', 'Task_Notify', { name: 'Нет', condition: '${!approved}' }),
      F('Task_Book', 'End_Ok'), F('Task_Notify', 'End_No')
    ]
  },

  // Pool with lanes, external (black-box) pools and message flows.
  loanLanes: {
    processId: 'loan-lanes', processName: 'Выдача кредита', platform: 'camunda8',
    pool: { name: 'Банк' },
    lanes: [
      { id: 'Lane_Manager', name: 'Кредитный менеджер' },
      { id: 'Lane_Risk', name: 'Риск-менеджмент' },
      { id: 'Lane_Back', name: 'Бэк-офис' }
    ],
    externalPools: [
      { id: 'Pool_Client', name: 'Клиент' },
      { id: 'Pool_Bureau', name: 'Бюро кредитных историй', position: 'bottom' }
    ],
    elements: [
      S('Start', 'startEvent', 'Заявка получена', { lane: 'Lane_Manager', eventDefinition: 'message', messageName: 'LoanRequest' }),
      S('Task_Check', 'userTask', 'Проверить документы', { lane: 'Lane_Manager', candidateGroups: 'managers', formId: 'check-docs' }),
      S('Timer_Docs', 'boundaryEvent', '2 дня', { attachedTo: 'Task_Check', eventDefinition: 'timer', timerValue: 'P2D', cancelActivity: false }),
      S('Task_Remind', 'sendTask', 'Напомнить менеджеру', { jobType: 'remind', lane: 'Lane_Manager' }),
      S('End_Remind', 'endEvent', 'Напоминание отправлено', { lane: 'Lane_Manager' }),
      S('Task_Request', 'sendTask', 'Запросить кредитную историю', { lane: 'Lane_Risk', jobType: 'bureau-request' }),
      S('Msg_Bureau', 'intermediateCatchEvent', 'История получена', { lane: 'Lane_Risk', eventDefinition: 'message', messageName: 'BureauReply', correlationKey: 'applicationId' }),
      S('Task_Score', 'businessRuleTask', 'Рассчитать скоринг', { lane: 'Lane_Risk', decisionId: 'scoring', resultVariable: 'score' }),
      S('Gateway_Approved', 'exclusiveGateway', 'Одобрено?', { lane: 'Lane_Risk' }),
      S('Task_Contract', 'userTask', 'Подготовить договор', { lane: 'Lane_Back', candidateGroups: 'backoffice', formId: 'contract' }),
      S('End_Ok', 'endEvent', 'Кредит выдан', { lane: 'Lane_Back' }),
      S('Task_Reject', 'sendTask', 'Отправить отказ', { lane: 'Lane_Manager', jobType: 'send-rejection' }),
      S('End_Rejected', 'endEvent', 'Отказано')
    ],
    flows: [
      F('Start', 'Task_Check'), F('Task_Check', 'Task_Request'), F('Timer_Docs', 'Task_Remind'), F('Task_Remind', 'End_Remind'),
      F('Task_Request', 'Msg_Bureau'), F('Msg_Bureau', 'Task_Score'), F('Task_Score', 'Gateway_Approved'),
      F('Gateway_Approved', 'Task_Contract', { name: 'Да', condition: 'score >= 700' }),
      F('Gateway_Approved', 'Task_Reject', { name: 'Нет', isDefault: true }),
      F('Task_Contract', 'End_Ok'), F('Task_Reject', 'End_Rejected')
    ],
    messageFlows: [
      { from: 'Pool_Client', to: 'Start', name: 'Заявка' },
      { from: 'Task_Request', to: 'Pool_Bureau', name: 'Запрос' },
      { from: 'Pool_Bureau', to: 'Msg_Bureau', name: 'Кредитная история' },
      { from: 'Task_Reject', to: 'Pool_Client', name: 'Отказ' },
      { from: 'End_Ok', to: 'Pool_Client', name: 'Договор' }
    ]
  },

  // Cyrillic ids must be transliterated, not collapsed into identical ids.
  cyrillicIds: {
    processName: 'Кириллица', platform: 'camunda8',
    elements: [
      S('Старт', 'startEvent', 'Начало'),
      S('Задача один', 'task', 'Первая'),
      S('Задача два', 'task', 'Вторая'),
      S('Сообщение', 'intermediateThrowEvent', 'Сигнал А', { eventDefinition: 'signal', signalName: 'Альфа' }),
      S('Сообщение2', 'intermediateThrowEvent', 'Сигнал Б', { eventDefinition: 'signal', signalName: 'Бета' }),
      S('Конец', 'endEvent', 'Конец')
    ],
    flows: [F('Старт', 'Задача один'), F('Задача один', 'Задача два'), F('Задача два', 'Сообщение'), F('Сообщение', 'Сообщение2'), F('Сообщение2', 'Конец')]
  }
};
