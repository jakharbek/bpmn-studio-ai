// Classic Camunda 7 editor: bpmn-js 7.4 with the Camunda properties panel 0.42, set up the standard way.
import BpmnModeler from 'bpmn-js/lib/Modeler';
import propertiesPanelModule from 'bpmn-js-properties-panel';
import propertiesProviderModule from 'bpmn-js-properties-panel/lib/provider/camunda';
import camundaModdleDescriptor from 'camunda-bpmn-moddle/resources/camunda.json';

export default class LegacyModeler extends BpmnModeler {
  constructor(options = {}) {
    super({
      ...options,
      additionalModules: [propertiesPanelModule, propertiesProviderModule, ...(options.additionalModules || [])],
      moddleExtensions: { camunda: camundaModdleDescriptor, ...(options.moddleExtensions || {}) }
    });
  }
}
