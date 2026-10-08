import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Observation } from '../types.ts';

type Node = Record<string, unknown>;
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, processEntities: true });
const node = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {};
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value : value ? [value] : []).map(node);
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(node(value)['#text'] ?? '');

export function parseFmiXml(xml: string): Node {
  if (Buffer.byteLength(xml) > 2 * 1024 ** 2 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('FMI XML exceeds safe bounds');
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed FMI XML');
  const parsed = xmlParser.parse(xml) as Node;
  if (parsed.ExceptionReport || parsed.ServiceExceptionReport) throw new Error(`FMI exception response: ${JSON.stringify(parsed).slice(0, 500)}`);
  return parsed;
}
export interface ParameterMetadata { unit: string; aggregation: string | null; label: string }
export function parseFmiParameters(xml: string): Record<string, ParameterMetadata> {
  const root = node(parseFmiXml(xml).CompositeObservableProperty);
  const result: Record<string, ParameterMetadata> = {};
  for (const component of nodes(root.component)) {
    const property = node(component.ObservableProperty);
    const id = text(property['@_id']).toLowerCase();
    const unit = text(node(property.uom)['@_uom']);
    if (!id || !unit || result[id]) throw new Error('Invalid FMI parameter metadata');
    const measure = node(node(property.statisticalMeasure).StatisticalMeasure);
    const period = text(measure.aggregationTimePeriod);
    const fn = text(measure.statisticalFunction);
    result[id] = { unit, label: text(property.label), aggregation: period ? `${fn || 'unknown'} ${period}` : null };
  }
  if (!Object.keys(result).length) throw new Error('No FMI parameter metadata');
  return result;
}
export function discoverFmiQueries(listXml: string, descriptionXml: string): string[] {
  const queries = nodes(node(parseFmiXml(listXml).ListStoredQueriesResponse).StoredQuery).map((query) => text(query['@_id']));
  const descriptions = nodes(node(parseFmiXml(descriptionXml).DescribeStoredQueriesResponse).StoredQueryDescription);
  const required = ['fmi::observations::weather::timevaluepair', 'urban::observations::airquality::hourly::timevaluepair'];
  for (const id of required) {
    const description = descriptions.find((query) => text(query['@_id']) === id);
    const parameters = nodes(description?.Parameter).map((parameter) => text(parameter['@_name']));
    if (!queries.includes(id) || !description || !['starttime', 'endtime', 'fmisid', 'parameters'].every((name) => parameters.includes(name))) {
      throw new Error(`FMI query metadata missing ${id}`);
    }
  }
  return required;
}
export function decodeFmiObservations(xml: string, metadata: Record<string, ParameterMetadata>, receivedAt: string, sourceId: string): Observation[] {
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid FMI reception time');
  const parsed = parseFmiXml(xml);
  if (!parsed.FeatureCollection) throw new Error('Expected FMI FeatureCollection');
  const observations: Observation[] = [];
  for (const member of nodes(node(parsed.FeatureCollection).member)) {
    const observation = node(member.PointTimeSeriesObservation);
    const propertyUrl = text(node(observation.observedProperty)['@_href']);
    const parameter = new URL(propertyUrl).searchParams.get('param');
    const parameterMetadata = parameter ? metadata[parameter.toLowerCase()] : undefined;
    if (!parameter || !parameterMetadata) throw new Error('FMI observation lacks verified parameter unit');
    const feature = node(node(observation.featureOfInterest).SF_SpatialSamplingFeature);
    const location = node(node(node(node(feature.sampledFeature).LocationCollection).member).Location);
    const stationId = text(location.identifier);
    const stationName = text(nodes(location.name).find((name) => text(name['@_codeSpace']).endsWith('/name')) ?? node(node(feature.shape).Point).name);
    const point = node(node(feature.shape).Point);
    if (text(point['@_srsName']) !== 'http://www.opengis.net/def/crs/EPSG/0/4258' || text(point['@_srsDimension']) !== '2') throw new Error('Unsupported FMI CRS/axis order');
    const position = text(point.pos).trim().split(/\s+/).map(Number);
    if (!stationId || !stationName || position.length !== 2 || !position.every(Number.isFinite) || Math.abs(position[0]) > 90 || Math.abs(position[1]) > 180) throw new Error('Invalid FMI station position');
    const [latitude, longitude] = position;
    const series = node(node(observation.result).MeasurementTimeseries);
    for (const entry of nodes(series.point)) {
      const tvp = node(entry.MeasurementTVP);
      const observedAt = text(tvp.time);
      if (!Number.isFinite(Date.parse(observedAt)) || !/Z$/.test(observedAt)) throw new Error('Invalid FMI observation time');
      const raw = text(tvp.value);
      const value = raw === 'NaN' || node(tvp.value)['@_nil'] === 'true' ? null : Number(raw);
      if (value !== null && (!raw || !Number.isFinite(value))) throw new Error('Invalid FMI observation number');
      observations.push({ stationId, stationName, longitude, latitude, parameter, value, unit: parameterMetadata.unit,
        observedAt: new Date(observedAt).toISOString(), receivedAt, quality: text(tvp.quality) || 'unknown',
        aggregation: parameterMetadata.aggregation, sourceId });
      if (observations.length > 5000) throw new Error('FMI retained observation limit exceeded');
    }
  }
  return observations;
}
