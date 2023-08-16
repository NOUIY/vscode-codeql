import * as React from "react";
import { AlertTable } from "./AlertTable";
import { Graph } from "./Graph";
import { RawTable } from "./RawTable";
import { ResultTableProps } from "./result-table-utils";

export function ResultTable(props: ResultTableProps) {
  const { resultSet } = props;
  switch (resultSet.t) {
    case "RawResultSet":
      return <RawTable {...props} resultSet={resultSet} />;
    case "InterpretedResultSet": {
      const data = resultSet.interpretation.data;
      switch (data.t) {
        case "SarifInterpretationData": {
          const sarifResultSet = {
            ...resultSet,
            interpretation: { ...resultSet.interpretation, data },
          };
          return <AlertTable {...props} resultSet={sarifResultSet} />;
        }
        case "GraphInterpretationData": {
          return (
            <Graph
              graphData={data?.dot[props.offset]}
              databaseUri={props.databaseUri}
            />
          );
        }
      }
    }
  }
}
